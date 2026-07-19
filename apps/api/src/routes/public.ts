// /v7/:projectId/public/* — the anonymous, GET-only internet-public read surface.
// Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
//
// The ONLY project-scoped prefix on AUTH_WALL_ALLOWLIST besides /auth/. Every route re-runs the
// internet-public gate ITSELF (assertEntityInternetPublic) — no route trusts another ran first,
// and nothing here branches on c.var.auth (privileged viewers use the normal walled surface).
// Removed comments are ALWAYS hidden: an anonymous caller is never privileged. 404, never 403.
import { Hono } from "hono";
import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { getDb } from "../db/index.js";
import { comments } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { resolveCommentSort, commentOrderBy } from "../lib/comment-sort.js";
import { markDeprecated } from "../http/deprecation.js";
import { assertEntityInternetPublic } from "../lib/public-access.js";
import { shapeComment, shapeEntity, parseInclude, loadUsers, loadEntityFiles } from "../lib/shape.js";

export const publicRoutes = new Hono<{ Variables: Variables }>()
  // Third-party embed CORS: this surface is anonymous, read-only, and serves only internet-public
  // data — allow any origin, never credentials. Post-next override beats the app-level CORS_ORIGIN.
  .use("*", async (c, next) => {
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
    c.res.headers.delete("Access-Control-Allow-Credentials");
  })
  .get("/entities/:id", async (c) => {
    const projectId = c.var.projectId;
    const row = await assertEntityInternetPublic(projectId, c.req.param("id"));
    const include = parseInclude(c);
    const opts: Parameters<typeof shapeEntity>[1] = {};
    if (include.has("user") && row.userId) {
      const users = await loadUsers(projectId, [row.userId]);
      opts.user = users.get(row.userId) ?? null;
    }
    if (include.has("files")) {
      const fileMap = await loadEntityFiles(projectId, [row.id]);
      opts.files = fileMap.get(row.id) ?? [];
    }
    return c.json(shapeEntity(row, opts));
  })
  // Paginated one-level comment list (mirrors the walled GET /comments?entityId=; parentId pages replies).
  .get("/entities/:id/comments", async (c) => {
    const projectId = c.var.projectId;
    const entityId = c.req.param("id");
    await assertEntityInternetPublic(projectId, entityId);
    const clean = (v: string | undefined) => (v && v !== "null" && v !== "undefined" ? v : undefined);
    const parentId = clean(c.req.query("parentId")) ?? null;
    const { page, limit, offset } = readPagination(c);
    const include = parseInclude(c);

    const conds: SQL[] = [
      eq(comments.projectId, projectId),
      eq(comments.entityId, entityId),
      isNull(comments.deletedAt),
      parentId ? eq(comments.parentId, parentId) : isNull(comments.parentId),
      // Anonymous is never privileged — removed rows are unconditionally hidden.
      sql`${comments.moderationStatus} is distinct from 'removed'`,
    ];
    const where = and(...conds);
    const sort = resolveCommentSort(c.req.query("sortBy"), c.req.query("sortDir"));
    if (sort.deprecated) markDeprecated(c);

    const rows = await getDb().select().from(comments).where(where)
      .orderBy(...commentOrderBy(sort)).limit(limit).offset(offset);
    const totals = await getDb().select({ total: count() }).from(comments).where(where);
    const total = totals[0]?.total ?? 0;

    const userMap = include.has("user") ? await loadUsers(projectId, rows.map((r) => r.userId)) : null;
    const shaped = rows.map((r) => shapeComment(r, {
      userReaction: null,
      ...(userMap ? { user: r.userId ? userMap.get(r.userId) ?? null : null } : {}),
    }));
    return c.json(paginate(shaped, total, page, limit));
  })
  // Full nested subtree (mirrors the walled GET /comments/thread), removed subtrees pruned in-RPC.
  .get("/entities/:id/comments/thread", async (c) => {
    const projectId = c.var.projectId;
    const entityId = c.req.param("id");
    await assertEntityInternetPublic(projectId, entityId);
    const rootRaw = c.req.query("rootId") ?? c.req.query("parentId") ?? null;
    const rootId = rootRaw && /^[0-9a-f-]{36}$/i.test(rootRaw) ? rootRaw : null;
    const { limit, offset } = readPagination(c, { page: 1, limit: 50 });
    const include = parseInclude(c);

    // p_hide_removed is unconditionally TRUE — anon is never privileged.
    const res = (await getDb().execute(sql`
      select id, parent_id, depth from fetch_comment_thread(${entityId}::uuid, ${rootId}::uuid, ${limit}, ${offset}, true)
    `)) as unknown as { id: string; parent_id: string | null; depth: number }[];
    if (res.length === 0) return c.json({ data: [] });

    const ids = res.map((r) => r.id);
    const rows = await getDb().select().from(comments)
      .where(and(eq(comments.projectId, projectId), inArray(comments.id, ids)));
    const userMap = include.has("user") ? await loadUsers(projectId, rows.map((r) => r.userId)) : null;

    type Node = ReturnType<typeof shapeComment> & { replies: Node[] };
    const nodeById = new Map<string, Node>();
    for (const r of rows) {
      const shaped = shapeComment(r, {
        userReaction: null,
        ...(userMap ? { user: r.userId ? userMap.get(r.userId) ?? null : null } : {}),
      });
      nodeById.set(r.id, { ...shaped, replies: [] });
    }
    // RPC rows are ordered by depth then created_at — parents are always seen before children.
    const roots: Node[] = [];
    for (const r of res) {
      const node = nodeById.get(r.id);
      if (!node) continue;
      const parent = r.depth > 0 && r.parent_id ? nodeById.get(r.parent_id) : null;
      (parent ? parent.replies : roots).push(node);
    }
    return c.json({ data: roots });
  });
