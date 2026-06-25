// /v7/:projectId/comments/*
// Data layer is Drizzle (db). One-level threaded reads (entityId + parentId) match the SDK's lazy
// "load more replies"; /thread additionally exposes the fetch_comment_thread RPC as a full nested
// subtree (server-only convenience — the SDK builds the tree client-side from one-level fetches).
import { Hono } from "hono";
import { and, eq, isNull, asc, desc, count, inArray, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { comments, reactions } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeComment, parseInclude, attachUserReactions, loadUsers } from "../lib/shape.js";
import {
  parseBody,
  createCommentSchema,
  updateCommentSchema,
  reactionSchema,
} from "../lib/validation.js";
import * as webhooks from "../lib/webhooks.js";
import { notifyOnComment, notifyOnReaction } from "../lib/notifications.js";
import { indexContentAsync } from "../lib/embeddings.js";
import { assertCanReadEntity, assertCanReadComment } from "../lib/space-access.js";
import { removedPolicy, excludeRemovedSql, shouldHide } from "../lib/moderation-visibility.js";

export const commentRoutes = new Hono<{ Variables: Variables }>()
  .get("/", async (c) => {
    const projectId = c.var.projectId;
    // SDK sends absent filters as the literal "null"/"undefined" — treat those as unset.
    const clean = (v: string | undefined) => (v && v !== "null" && v !== "undefined" ? v : undefined);
    const entityId = clean(c.req.query("entityId"));
    if (!entityId) throw Errors.badRequest("comments/missing-entity-id", "entityId is required", "entityId");
    await assertCanReadEntity(c, entityId); // comments inherit the entity's space read gate
    const parentId = clean(c.req.query("parentId")) ?? null;
    const { page, limit, offset } = readPagination(c);
    const include = parseInclude(c);

    const conds: SQL[] = [
      eq(comments.projectId, projectId),
      eq(comments.entityId, entityId),
      isNull(comments.deletedAt),
      parentId ? eq(comments.parentId, parentId) : isNull(comments.parentId),
    ];
    // Moderation-removed comments are hidden from the list for non-moderators (operators bypass).
    const removed = await removedPolicy(c);
    const excludeRemoved = excludeRemovedSql(removed, comments);
    if (excludeRemoved) conds.push(excludeRemoved);
    const where = and(...conds);

    // SDK CommentsSortByOptions: "top" | "new" | "old" (new = newest first, old = oldest first).
    const sortBy = c.req.query("sortBy");
    const order =
      sortBy === "top" ? [desc(sql`coalesce((${comments.reactionCounts}->>'upvote')::int, 0)`), desc(comments.createdAt)]
      : sortBy === "old" ? [asc(comments.createdAt)]
      : [desc(comments.createdAt)]; // "new" (default)

    const rows = await db
      .select()
      .from(comments)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset);
    const totals = await db.select({ total: count() }).from(comments).where(where);
    const total = totals[0]?.total ?? 0;

    const reactionMap = await attachUserReactions(projectId, "comment", rows.map((r) => r.id), c.var.auth?.userId);
    const userMap = include.has("user") ? await loadUsers(projectId, rows.map((r) => r.userId)) : null;
    const shaped = rows.map((r) =>
      shapeComment(r, {
        userReaction: reactionMap.get(r.id) ?? null,
        ...(userMap ? { user: r.userId ? userMap.get(r.userId) ?? null : null } : {}),
      })
    );
    return c.json(paginate(shaped, total, page, limit));
  })
  .post("/", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const userId = c.var.auth!.userId;
    const body = parseBody(createCommentSchema, await c.req.json().catch(() => ({})), "comments");
    await assertCanReadEntity(c, body.entityId); // can't comment on content you can't read
    // Blocking validation webhook (host app may veto). Passes through if unconfigured/unsubscribed.
    const check = await webhooks.validate(projectId, "comment.created", { ...body, userId });
    if (!check.valid) throw Errors.forbidden("comments/rejected", check.message ?? "Comment rejected by validation webhook");
    // Trigger (0002) bumps entity.replies_count + parent.replies_count on insert.
    const [row] = await db
      .insert(comments)
      .values({
        projectId,
        userId,
        entityId: body.entityId,
        parentId: body.parentId ?? undefined,
        content: body.content,
        gif: body.gif ?? undefined,
        foreignId: body.foreignId,
        // null → undefined so Drizzle applies the NOT NULL jsonb defaults
        mentions: body.mentions ?? undefined,
        metadata: body.metadata ?? undefined,
      })
      .returning();
    if (!row) throw Errors.badRequest("comments/create-failed", "Insert returned no row");
    indexContentAsync(projectId, "comment", row.id, row.content);
    await notifyOnComment(projectId, row);
    const shaped = shapeComment(row);
    logger.info({ projectId, commentId: row.id, entityId: row.entityId, userId: row.userId, parentId: row.parentId ?? null }, "comment: created");
    webhooks.broadcast(projectId, "comment.created.complete", shaped);
    return c.json(shaped, 201);
  })
  .get("/by-foreign-id", async (c) => {
    const projectId = c.var.projectId;
    const foreignId = c.req.query("foreignId");
    if (!foreignId) throw Errors.badRequest("comments/missing-foreign-id", "foreignId is required", "foreignId");
    const [row] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.projectId, projectId), eq(comments.foreignId, foreignId), isNull(comments.deletedAt)))
      .limit(1);
    if (!row) throw Errors.notFound("comments/not-found", "Comment not found");
    await assertCanReadEntity(c, row.entityId); // private-space leak guard
    const removed = await removedPolicy(c);
    if (shouldHide(removed, row.moderationStatus)) throw Errors.notFound("comments/not-found", "Comment not found");
    const shaped = await hydrateOne(c, row);
    // SDK's useFetchCommentByForeignId expects { comment }.
    return c.json({ comment: shaped });
  })
  // Full nested subtree for an entity (or under a root comment) via the fetch_comment_thread RPC.
  // Server-only convenience: returns { data: Comment[] } where each comment carries a `replies` array.
  .get("/thread", async (c) => {
    const projectId = c.var.projectId;
    const entityId = c.req.query("entityId");
    if (!entityId) throw Errors.badRequest("comments/missing-entity-id", "entityId is required", "entityId");
    await assertCanReadEntity(c, entityId); // thread inherits the entity's space read gate
    const rootId = c.req.query("rootId") ?? c.req.query("parentId") ?? null;
    const { limit, offset } = readPagination(c, { page: 1, limit: 50 });
    const include = parseInclude(c);

    // Moderation visibility is pushed into the RPC: for non-privileged viewers it prunes removed
    // comments AND their descendant subtrees (a JS post-filter would orphan the children).
    const removed = await removedPolicy(c);
    const hideRemoved = !removed.privileged;
    const res = (await db.execute(sql`
      select id, parent_id, depth from fetch_comment_thread(${entityId}::uuid, ${rootId}::uuid, ${limit}, ${offset}, ${hideRemoved})
    `)) as unknown as { id: string; parent_id: string | null; depth: number }[];
    if (res.length === 0) return c.json({ data: [] });

    const ids = res.map((r) => r.id);
    const rows = await db.select().from(comments)
      .where(and(eq(comments.projectId, projectId), inArray(comments.id, ids)));
    const byRow = new Map(rows.map((r) => [r.id, r]));
    const reactionMap = await attachUserReactions(projectId, "comment", ids, c.var.auth?.userId);
    const userMap = include.has("user") ? await loadUsers(projectId, rows.map((r) => r.userId)) : null;

    type Node = ReturnType<typeof shapeComment> & { replies: Node[] };
    const nodeById = new Map<string, Node>();
    for (const r of rows) {
      // Removed rows were already pruned in the RPC for non-privileged viewers.
      const shaped = shapeComment(r, {
        userReaction: reactionMap.get(r.id) ?? null,
        ...(userMap ? { user: r.userId ? userMap.get(r.userId) ?? null : null } : {}),
      });
      nodeById.set(r.id, { ...shaped, replies: [] });
    }
    // RPC rows are ordered by depth then created_at, so a parent is always seen before its children.
    const roots: Node[] = [];
    for (const r of res) {
      const node = nodeById.get(r.id);
      if (!node) continue;
      const parent = r.depth > 0 && r.parent_id ? nodeById.get(r.parent_id) : null;
      (parent ? parent.replies : roots).push(node);
    }
    return c.json({ data: roots });
  })
  .get("/:id", async (c) => {
    const projectId = c.var.projectId;
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.projectId, projectId), eq(comments.id, id), isNull(comments.deletedAt)))
      .limit(1);
    if (!row) throw Errors.notFound("comments/not-found", "Comment not found");
    await assertCanReadEntity(c, row.entityId); // private-space leak guard
    const removed = await removedPolicy(c);
    if (shouldHide(removed, row.moderationStatus)) throw Errors.notFound("comments/not-found", "Comment not found");
    const shaped = await hydrateOne(c, row);
    // SDK's useFetchComment expects { comment }.
    return c.json({ comment: shaped });
  })
  .patch("/:id", requireAuth, async (c) => {
    const row = await ownedComment(c);
    const body = parseBody(updateCommentSchema, await c.req.json().catch(() => ({})), "comments");
    const check = await webhooks.validate(c.var.projectId, "comment.updated", { ...body, id: row.id, userId: row.userId });
    if (!check.valid) throw Errors.forbidden("comments/rejected", check.message ?? "Comment update rejected by validation webhook");
    const patch: Record<string, unknown> = {};
    if (body.content !== undefined) patch.content = body.content;
    if (body.gif !== undefined) patch.gif = body.gif;
    if (body.mentions !== undefined) patch.mentions = body.mentions;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    const [updated] = await db.update(comments).set(patch).where(eq(comments.id, row.id)).returning();
    if (body.content !== undefined) indexContentAsync(c.var.projectId, "comment", updated!.id, updated!.content);
    const shaped = shapeComment(updated!);
    logger.info({ projectId: c.var.projectId, commentId: row.id, entityId: updated!.entityId, userId: row.userId, fields: Object.keys(patch) }, "comment: updated");
    webhooks.broadcast(c.var.projectId, "comment.updated.complete", shaped);
    return c.json(shaped);
  })
  .delete("/:id", requireAuth, async (c) => {
    const row = await ownedComment(c);
    // Reddit-style soft delete: keep the row (preserves thread), blank via user_deleted_at.
    const now = new Date();
    await db.update(comments).set({ deletedAt: now, userDeletedAt: now }).where(eq(comments.id, row.id));
    logger.info({ projectId: c.var.projectId, commentId: row.id, userId: row.userId }, "comment: deleted");
    return c.json({ success: true });
  })
  // SDK (useFetchCommentReactions) — paginated list of who reacted, gated by comment read access.
  .get("/:id/reactions", async (c) => {
    const targetId = c.req.param("id");
    await assertCanReadComment(c, targetId);
    const { page, limit, offset } = readPagination(c);
    const rt = c.req.query("reactionType");
    const where = and(
      eq(reactions.projectId, c.var.projectId),
      eq(reactions.targetType, "comment"),
      eq(reactions.targetId, targetId),
      rt ? eq(reactions.reactionType, rt as any) : undefined,
    );
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(reactions).where(where);
    const rows = await db.select().from(reactions).where(where)
      .orderBy(desc(reactions.createdAt)).limit(limit).offset(offset);
    const userMap = await loadUsers(c.var.projectId, rows.map((r) => r.userId));
    const data = rows.map((r) => ({
      id: r.id, userId: r.userId, reactionType: r.reactionType,
      createdAt: r.createdAt.toISOString(), user: userMap.get(r.userId) ?? null,
    }));
    return c.json(paginate(data, n, page, limit));
  })
  .post("/:id/reactions", requireAuth, async (c) => {
    await assertCanReadComment(c, c.req.param("id")); // can't react to content you can't read
    const { reactionType } = parseBody(reactionSchema, await c.req.json().catch(() => ({})), "comments");
    const result = await toggleCommentReaction(c, reactionType);
    await notifyOnReaction({
      projectId: c.var.projectId,
      targetType: "comment",
      targetId: c.req.param("id"),
      reactorId: c.var.auth!.userId,
      reactionType,
      isActive: result.userReaction === reactionType,
      reactionCounts: result.reactionCounts,
    });
    return c.json(result);
  })
  .delete("/:id/reactions", requireAuth, async (c) => {
    return c.json(await clearCommentReaction(c));
  });

// ─── shared helpers ────────────────────────────────────────────────────────

// Shape a single comment with userReaction + optional include of `user` / `parent` (→ parentComment).
async function hydrateOne(c: any, row: typeof comments.$inferSelect) {
  const projectId = c.var.projectId;
  const include = parseInclude(c);
  const reactionMap = await attachUserReactions(projectId, "comment", [row.id], c.var.auth?.userId);
  const opts: { userReaction: any; user?: any; parent?: any } = { userReaction: reactionMap.get(row.id) ?? null };
  if (include.has("user")) {
    const userMap = await loadUsers(projectId, [row.userId]);
    opts.user = row.userId ? userMap.get(row.userId) ?? null : null;
  }
  if (include.has("parent")) {
    if (row.parentId) {
      const [p] = await db.select().from(comments)
        .where(and(eq(comments.projectId, projectId), eq(comments.id, row.parentId))).limit(1);
      opts.parent = p ? shapeComment(p) : null;
    } else {
      opts.parent = null;
    }
  }
  return shapeComment(row, opts);
}

async function ownedComment(c: any): Promise<{ id: string; userId: string | null }> {
  const projectId = c.var.projectId;
  const id = c.req.param("id");
  const [row] = await db
    .select({ id: comments.id, userId: comments.userId })
    .from(comments)
    .where(and(eq(comments.projectId, projectId), eq(comments.id, id), isNull(comments.deletedAt)))
    .limit(1);
  if (!row) throw Errors.notFound("comments/not-found", "Comment not found");
  if (row.userId !== c.var.auth.userId) throw Errors.forbidden("comments/not-owner", "Not the owner");
  return row;
}

async function toggleCommentReaction(c: any, type: string) {
  const projectId = c.var.projectId;
  const id = c.req.param("id");
  const userId = c.var.auth.userId;
  const res = await db.execute(
    sql`select toggle_reaction(${projectId}::uuid, 'comment'::reaction_target, ${id}::uuid, ${userId}::uuid, ${type}::reaction_type) as counts`
  );
  return {
    reactionCounts: (res as any)[0]?.counts ?? null,
    userReaction: await currentReaction(projectId, id, userId),
  };
}

async function clearCommentReaction(c: any) {
  const projectId = c.var.projectId;
  const id = c.req.param("id");
  const userId = c.var.auth.userId;
  await db
    .delete(reactions)
    .where(
      and(
        eq(reactions.projectId, projectId),
        eq(reactions.targetType, "comment"),
        eq(reactions.targetId, id),
        eq(reactions.userId, userId)
      )
    );
  const [row] = await db.select({ rc: comments.reactionCounts }).from(comments).where(eq(comments.id, id)).limit(1);
  return { reactionCounts: row?.rc ?? null, userReaction: null };
}

async function currentReaction(projectId: string, id: string, userId: string) {
  const [row] = await db
    .select({ reactionType: reactions.reactionType })
    .from(reactions)
    .where(
      and(
        eq(reactions.projectId, projectId),
        eq(reactions.targetType, "comment"),
        eq(reactions.targetId, id),
        eq(reactions.userId, userId)
      )
    )
    .limit(1);
  return row?.reactionType ?? null;
}
