// /v7/:projectId/follows/*  — the authenticated user's own follow graph.
import { Hono } from "hono";
import { and, eq, count, inArray } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { follows, profiles } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeUser } from "../lib/shape.js";
import { normalizeUserSearch, userSearchCondition } from "../lib/user-search.js";

// Page of the users on the other side of the auth user's follow edges.
async function selfFollowList(
  projectId: string,
  userId: string,
  kind: "followers" | "following",
  page: number,
  limit: number,
  offset: number,
  query?: string,
  searchFields?: string,
) {
  const matchCol = kind === "followers" ? follows.followedId : follows.followerId;
  const pickCol = kind === "followers" ? follows.followerId : follows.followedId;
  const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(follows)
    .where(and(eq(follows.projectId, projectId), eq(matchCol, userId)));
  const rows = await getDb().select({ pid: pickCol }).from(follows)
    .where(and(eq(follows.projectId, projectId), eq(matchCol, userId)))
    .limit(limit).offset(offset);
  const ids = rows.map((r) => r.pid);
  const { like, fields } = normalizeUserSearch(query, searchFields);
  const searchCond = userSearchCondition(like, fields, { username: profiles.username, name: profiles.name });
  const users = ids.length
    ? await getDb().select().from(profiles).where(and(eq(profiles.projectId, projectId), inArray(profiles.id, ids), searchCond))
    : [];
  const byId = new Map(users.map((u) => [u.id, shapeUser(u)]));
  return paginate(ids.map((i) => byId.get(i)).filter(Boolean), n, page, limit);
}

export const followRoutes = new Hono<{ Variables: Variables }>()
  .get("/followers", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    return c.json(await selfFollowList(c.var.projectId, c.var.auth!.userId, "followers", page, limit, offset, c.req.query("query"), c.req.query("searchFields")));
  })
  .get("/following", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    return c.json(await selfFollowList(c.var.projectId, c.var.auth!.userId, "following", page, limit, offset, c.req.query("query"), c.req.query("searchFields")));
  })
  .get("/followers-count", requireAuth, async (c) => {
    const [r] = await getDb().select({ n: count() }).from(follows)
      .where(and(eq(follows.projectId, c.var.projectId), eq(follows.followedId, c.var.auth!.userId)));
    return c.json({ count: r?.n ?? 0 });
  })
  .get("/following-count", requireAuth, async (c) => {
    const [r] = await getDb().select({ n: count() }).from(follows)
      .where(and(eq(follows.projectId, c.var.projectId), eq(follows.followerId, c.var.auth!.userId)));
    return c.json({ count: r?.n ?? 0 });
  })
  .delete("/:id", requireAuth, async (c) => {
    // Only the follower may delete their own follow edge.
    const [row] = await getDb().select({ followerId: follows.followerId }).from(follows)
      .where(and(eq(follows.projectId, c.var.projectId), eq(follows.id, c.req.param("id")))).limit(1);
    if (!row) throw Errors.notFound("follows/not-found", "Follow not found");
    if (row.followerId !== c.var.auth!.userId) throw Errors.forbidden("follows/not-owner", "Not your follow");
    await getDb().delete(follows).where(eq(follows.id, c.req.param("id")));
    return c.json({ success: true });
  });
