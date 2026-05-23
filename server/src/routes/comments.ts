// /v7/:projectId/comments/*
// Data layer is Drizzle (db). One-level threaded reads (entityId + parentId) match the
// SDK's lazy "load more replies". fetch_comment_thread RPC stays for a future full-tree endpoint.
import { Hono } from "hono";
import { and, eq, isNull, asc, count, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
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

export const commentRoutes = new Hono<{ Variables: Variables }>()
  .get("/", async (c) => {
    const projectId = c.var.projectId;
    const entityId = c.req.query("entityId");
    if (!entityId) throw Errors.badRequest("comments/missing-entity-id", "entityId is required", "entityId");
    const parentId = c.req.query("parentId") ?? null;
    const { page, limit, offset } = readPagination(c);
    const include = parseInclude(c);

    const conds: SQL[] = [
      eq(comments.projectId, projectId),
      eq(comments.entityId, entityId),
      isNull(comments.deletedAt),
      parentId ? eq(comments.parentId, parentId) : isNull(comments.parentId),
    ];
    const where = and(...conds);

    const rows = await db
      .select()
      .from(comments)
      .where(where)
      .orderBy(asc(comments.createdAt))
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
    return c.json(shapeComment(row));
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
    const reactionMap = await attachUserReactions(projectId, "comment", [id], c.var.auth?.userId);
    return c.json(shapeComment(row, { userReaction: reactionMap.get(id) ?? null }));
  })
  .patch("/:id", requireAuth, async (c) => {
    const row = await ownedComment(c);
    const body = parseBody(updateCommentSchema, await c.req.json().catch(() => ({})), "comments");
    const patch: Record<string, unknown> = {};
    if (body.content !== undefined) patch.content = body.content;
    if (body.gif !== undefined) patch.gif = body.gif;
    if (body.mentions !== undefined) patch.mentions = body.mentions;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    const [updated] = await db.update(comments).set(patch).where(eq(comments.id, row.id)).returning();
    if (body.content !== undefined) indexContentAsync(c.var.projectId, "comment", updated!.id, updated!.content);
    return c.json(shapeComment(updated!));
  })
  .delete("/:id", requireAuth, async (c) => {
    const row = await ownedComment(c);
    // Reddit-style soft delete: keep the row (preserves thread), blank via user_deleted_at.
    const now = new Date();
    await db.update(comments).set({ deletedAt: now, userDeletedAt: now }).where(eq(comments.id, row.id));
    return c.json({ success: true });
  })
  .post("/:id/reactions", requireAuth, async (c) => {
    const { type } = parseBody(reactionSchema, await c.req.json().catch(() => ({})), "comments");
    const result = await toggleCommentReaction(c, type);
    await notifyOnReaction({
      projectId: c.var.projectId,
      targetType: "comment",
      targetId: c.req.param("id"),
      reactorId: c.var.auth!.userId,
      reactionType: type,
      isActive: result.userReaction === type,
      reactionCounts: result.reactionCounts,
    });
    return c.json(result);
  })
  .delete("/:id/reactions", requireAuth, async (c) => {
    return c.json(await clearCommentReaction(c));
  });

// ─── shared helpers ────────────────────────────────────────────────────────

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
