// /v7/:projectId/public/* — the anonymous, GET-only internet-public read surface.
// Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
//
// The ONLY project-scoped prefix on AUTH_WALL_ALLOWLIST besides /auth/. Every route re-runs the
// internet-public gate ITSELF (assertEntityInternetPublic) — no route trusts another ran first,
// and nothing here branches on c.var.auth (privileged viewers use the normal walled surface).
// Removed comments are ALWAYS hidden: an anonymous caller is never privileged. 404, never 403.
import { Hono } from "hono";
import { etag, RETAINED_304_HEADERS } from "hono/etag";
import { z } from "zod";
import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { getDb } from "../db/index.js";
import { comments } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { Errors } from "../http/errors.js";
import { resolveCommentSort, commentOrderBy } from "../lib/comment-sort.js";
import { markDeprecated } from "../http/deprecation.js";
import { assertEntityInternetPublic, assertForeignIdInternetPublic, notFound } from "../lib/public-access.js";
import { publicCacheControl } from "../lib/public-cache.js";
import { shapeComment, shapeEntity, parseInclude, loadUsers, loadEntityFiles } from "../lib/shape.js";
import type { User } from "@agora-server/contract";

// Anonymous surface: least-privilege redaction — the internet gets username/name/avatar/bio,
// never birthdate or the free-form profile metadata jsonb. Applied at every ?include=user site
// on this router (entity, comment list, comment thread). Spec follow-up: PII redaction wasn't in
// the original design (docs/superpowers/specs/2026-07-18-internet-public-entities-design.md §3).
function redactPublicUser(user: User | null): User | null {
  return user ? { ...user, birthdate: null, metadata: {} } : null;
}

/** Shape a gated entity with the surface's `?include=` support. Shared by both entity routes so the
 *  uuid and foreign-id paths can never drift on redaction or includes. */
async function shapePublicEntity(
  c: Parameters<typeof parseInclude>[0],
  projectId: string,
  row: Awaited<ReturnType<typeof assertEntityInternetPublic>>,
) {
  const include = parseInclude(c);
  const opts: Parameters<typeof shapeEntity>[1] = {};
  if (include.has("user") && row.userId) {
    const users = await loadUsers(projectId, [row.userId]);
    opts.user = redactPublicUser(users.get(row.userId) ?? null);
  }
  if (include.has("files")) {
    const fileMap = await loadEntityFiles(projectId, [row.id]);
    opts.files = fileMap.get(row.id) ?? [];
  }
  return shapeEntity(row, opts);
}

export const publicRoutes = new Hono<{ Variables: Variables }>()
  // Third-party embed CORS + shared-cache policy. Registered BEFORE etag() so its post-next block
  // runs LAST (post phases unwind in reverse): etag() converts a matched request into a 304 and
  // strips every header outside its retained list — including ACAO — so this block must get the
  // final word, or a cross-origin embed's revalidation would come back without ACAO and be blocked
  // by the browser.
  .use("*", async (c, next) => {
    await next();
    // Anonymous, read-only, internet-public data only — any origin, never credentials.
    c.res.headers.set("Access-Control-Allow-Origin", "*");
    c.res.headers.delete("Access-Control-Allow-Credentials");
    // (The matching `Vary: Origin` strip lives in app.ts, next to the cors() that stages it — this
    // router is a mounted sub-app, so Hono re-merges the parent's staged headers over anything
    // deleted here.)
    c.res.headers.set("Cache-Control", publicCacheControl(c.res.status));
  })
  // Conditional requests: a browser revalidating on every read (max-age=0) gets a 304 with an empty
  // body instead of the full thread. Retain X-Source-Code through the 304 — AGPL §13 advertises the
  // corresponding source on every response, and hono's default retained list would drop it.
  .use("*", etag({ retainedHeaders: [...RETAINED_304_HEADERS, "x-source-code"] }))
  // MUST stay above /entities/:id — Hono matches in declaration order, so a later static route of
  // the same segment count is swallowed by the param route (see CLAUDE.md, Handler conventions).
  // The anonymous mirror of the walled GET /entities/by-foreign-id: lets an embed address a
  // published anchor by the host app's own stable key instead of a per-install uuid.
  // NOTE: deliberately NO `createIfNotFound`. The walled route's flag lazily INSERTS an authorless
  // anchor; this surface is read-only and unauthenticated, so honouring it would hand anonymous
  // callers a row-creation primitive. An unknown foreignId just 404s.
  .get("/entities/by-foreign-id", async (c) => {
    const projectId = c.var.projectId;
    const foreignId = c.req.query("foreignId");
    // Missing param is malformed input, not an existence question — 400 reveals nothing about any
    // entity, and mirrors the walled route's own error.
    if (!foreignId) throw Errors.badRequest("entities/missing-foreign-id", "foreignId is required", "foreignId");
    const row = await assertForeignIdInternetPublic(projectId, foreignId);
    return c.json(await shapePublicEntity(c, projectId, row));
  })
  .get("/entities/:id", async (c) => {
    const projectId = c.var.projectId;
    const row = await assertEntityInternetPublic(projectId, c.req.param("id"));
    return c.json(await shapePublicEntity(c, projectId, row));
  })
  // Paginated one-level comment list (mirrors the walled GET /comments?entityId=; parentId pages replies).
  .get("/entities/:id/comments", async (c) => {
    const projectId = c.var.projectId;
    const entityId = c.req.param("id");
    await assertEntityInternetPublic(projectId, entityId);
    const clean = (v: string | undefined) => (v && v !== "null" && v !== "undefined" ? v : undefined);
    const parentIdRaw = clean(c.req.query("parentId"));
    // A malformed parentId would otherwise reach eq(comments.parentId, ...) and 22P02 (invalid
    // uuid) out of Postgres → 500. This surface is probed by anonymous strangers — malformed input
    // 404s like everything else on the gate, never 500s.
    if (parentIdRaw && !z.string().uuid().safeParse(parentIdRaw).success) {
      throw notFound();
    }
    const parentId = parentIdRaw ?? null;
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
      ...(userMap ? { user: redactPublicUser(r.userId ? userMap.get(r.userId) ?? null : null) } : {}),
    }));
    return c.json(paginate(shaped, total, page, limit));
  })
  // Full nested subtree (mirrors the walled GET /comments/thread), removed subtrees pruned in-RPC.
  .get("/entities/:id/comments/thread", async (c) => {
    const projectId = c.var.projectId;
    const entityId = c.req.param("id");
    await assertEntityInternetPublic(projectId, entityId);
    const rootRaw = c.req.query("rootId") ?? c.req.query("parentId") ?? null;
    // A strict uuid check, not the old loose 36-char/hyphen regex (which admitted e.g. 36 hyphens
    // straight into a ::uuid cast → Postgres 22P02 → 500). Garbage rootId still means "whole
    // thread" (null), it just can't reach the RPC as garbage.
    const rootId = rootRaw && z.string().uuid().safeParse(rootRaw).success ? rootRaw : null;
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
        ...(userMap ? { user: redactPublicUser(r.userId ? userMap.get(r.userId) ?? null : null) } : {}),
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
