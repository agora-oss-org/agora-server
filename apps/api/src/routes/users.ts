// /v7/:projectId/users/*
// Static routes (/by-username, /check-username, …) MUST stay above /:id.
import { Hono } from "hono";
import { and, eq, ne, or, count, desc, ilike, inArray } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { profiles, follows, connections } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeUser } from "../lib/shape.js";
import { parseBody, updateProfileSchema } from "../lib/validation.js";
import { notifyOnFollow } from "../lib/notifications.js";
import * as webhooks from "../lib/webhooks.js";

async function findUser(projectId: string, col: typeof profiles.id | typeof profiles.username | typeof profiles.foreignId, value: string) {
  const [row] = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.projectId, projectId), eq(col, value)))
    .limit(1);
  return row ?? null;
}

export const userRoutes = new Hono<{ Variables: Variables }>()
  .get("/by-foreign-id", async (c) => {
    const foreignId = c.req.query("foreignId");
    if (!foreignId) throw Errors.badRequest("users/missing-foreign-id", "foreignId is required", "foreignId");
    const row = await findUser(c.var.projectId, profiles.foreignId, foreignId);
    if (!row) throw Errors.notFound("users/not-found", "User not found");
    return c.json(shapeUser(row));
  })
  .get("/by-username", async (c) => {
    const username = c.req.query("username");
    if (!username) throw Errors.badRequest("users/missing-username", "username is required", "username");
    const row = await findUser(c.var.projectId, profiles.username, username);
    if (!row) throw Errors.notFound("users/not-found", "User not found");
    return c.json(shapeUser(row));
  })
  .get("/check-username", async (c) => {
    const username = c.req.query("username");
    if (!username) throw Errors.badRequest("users/missing-username", "username is required", "username");
    const row = await findUser(c.var.projectId, profiles.username, username);
    return c.json({ available: !row });
  })
  .get("/suggestions", async (c) => {
    const { limit } = readPagination(c, { page: 1, limit: 10 });
    const exclude = c.var.auth?.userId;
    const rows = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.projectId, c.var.projectId), exclude ? ne(profiles.id, exclude) : undefined))
      .orderBy(desc(profiles.reputation))
      .limit(limit);
    return c.json({ data: rows.map(shapeUser) });
  })
  .get("/:id", async (c) => {
    const row = await findUser(c.var.projectId, profiles.id, c.req.param("id"));
    if (!row) throw Errors.notFound("users/not-found", "User not found");
    return c.json(shapeUser(row));
  })
  .patch("/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (id !== c.var.auth!.userId) throw Errors.forbidden("users/not-self", "Can only update your own profile");
    const body = parseBody(updateProfileSchema, await c.req.json().catch(() => ({})), "users");
    const check = await webhooks.validate(c.var.projectId, "user.updated", { ...body, id });
    if (!check.valid) throw Errors.forbidden("users/rejected", check.message ?? "Profile update rejected by validation webhook");
    const [row] = await db
      .update(profiles)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.username !== undefined ? { username: body.username } : {}),
        ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
        ...(body.bio !== undefined ? { bio: body.bio } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      })
      .where(and(eq(profiles.projectId, c.var.projectId), eq(profiles.id, id)))
      .returning();
    if (!row) throw Errors.notFound("users/not-found", "User not found");
    const shaped = shapeUser(row);
    webhooks.broadcast(c.var.projectId, "user.updated.complete", shaped);
    return c.json(shaped);
  })
  // ── follow relationship ───────────────────────────────────────────────────
  .get("/:id/follow", requireAuth, async (c) => {
    const [row] = await db
      .select({ id: follows.id })
      .from(follows)
      .where(and(
        eq(follows.projectId, c.var.projectId),
        eq(follows.followerId, c.var.auth!.userId),
        eq(follows.followedId, c.req.param("id"))
      ))
      .limit(1);
    return c.json({ isFollowing: !!row, followId: row?.id ?? null });
  })
  .post("/:id/follow", requireAuth, async (c) => {
    const followedId = c.req.param("id");
    const followerId = c.var.auth!.userId;
    if (followedId === followerId) throw Errors.badRequest("users/self-follow", "Cannot follow yourself");
    const [row] = await db
      .insert(follows)
      .values({ projectId: c.var.projectId, followerId, followedId })
      .onConflictDoNothing()
      .returning();
    // already following -> fetch existing id
    if (!row) {
      const [existing] = await db.select({ id: follows.id }).from(follows)
        .where(and(eq(follows.projectId, c.var.projectId), eq(follows.followerId, followerId), eq(follows.followedId, followedId)))
        .limit(1);
      return c.json({ id: existing?.id, followedId });
    }
    // Notify only on a genuinely new follow (onConflictDoNothing returned a row).
    await notifyOnFollow(c.var.projectId, followerId, followedId);
    return c.json({ id: row.id, followedId }, 201);
  })
  .delete("/:id/follow", requireAuth, async (c) => {
    await db.delete(follows).where(and(
      eq(follows.projectId, c.var.projectId),
      eq(follows.followerId, c.var.auth!.userId),
      eq(follows.followedId, c.req.param("id"))
    ));
    return c.json({ success: true });
  })
  .get("/:id/followers", async (c) => {
    const { page, limit, offset } = readPagination(c);
    return c.json(await followList(c.var.projectId, "followers", c.req.param("id"), page, limit, offset));
  })
  .get("/:id/following", async (c) => {
    const { page, limit, offset } = readPagination(c);
    return c.json(await followList(c.var.projectId, "following", c.req.param("id"), page, limit, offset));
  })
  .get("/:id/followers-count", async (c) => {
    const [r] = await db.select({ n: count() }).from(follows)
      .where(and(eq(follows.projectId, c.var.projectId), eq(follows.followedId, c.req.param("id"))));
    return c.json({ count: r?.n ?? 0 });
  })
  .get("/:id/following-count", async (c) => {
    const [r] = await db.select({ n: count() }).from(follows)
      .where(and(eq(follows.projectId, c.var.projectId), eq(follows.followerId, c.req.param("id"))));
    return c.json({ count: r?.n ?? 0 });
  })
  .get("/:id/connections-count", async (c) => {
    const id = c.req.param("id");
    const [r] = await db.select({ n: count() }).from(connections)
      .where(and(
        eq(connections.projectId, c.var.projectId),
        eq(connections.status, "connected"),
        or(eq(connections.requesterId, id), eq(connections.addresseeId, id))
      ));
    return c.json({ count: r?.n ?? 0 });
  });

// Shared: paginated follower/following user lists.
async function followList(projectId: string, kind: "followers" | "following", id: string, page: number, limit: number, offset: number) {
  // followers: people who follow `id` (follower_id -> user). following: people `id` follows (followed_id).
  const matchCol = kind === "followers" ? follows.followedId : follows.followerId;
  const pickCol = kind === "followers" ? follows.followerId : follows.followedId;

  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(follows)
    .where(and(eq(follows.projectId, projectId), eq(matchCol, id)));
  const rows = await db
    .select({ pid: pickCol })
    .from(follows)
    .where(and(eq(follows.projectId, projectId), eq(matchCol, id)))
    .limit(limit)
    .offset(offset);
  const ids = rows.map((r) => r.pid);
  const users = ids.length
    ? await db.select().from(profiles).where(and(eq(profiles.projectId, projectId), inArray(profiles.id, ids)))
    : [];
  const byId = new Map(users.map((u) => [u.id, shapeUser(u)]));
  const data = ids.map((i) => byId.get(i)).filter(Boolean);
  return paginate(data, n, page, limit);
}
