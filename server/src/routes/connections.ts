// Connections — bidirectional friend-request state machine (none → pending → connected/declined).
// NOTE: per the Replyke contract these endpoints are NOT under /:projectId — they live at the
// /v7 root and derive the project from the authenticated user's profile. Mounted before the
// /:projectId catch-all (Hono prioritizes the static /connections + /users segments over the param).
import { Hono } from "hono";
import { and, eq, or, count, desc } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { connections, profiles, appNotifications } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeUser } from "../lib/shape.js";
import { parseBody, connectionRequestSchema } from "../lib/validation.js";

type ConnRow = typeof connections.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;

// The authenticated user's profile (also yields the project these connections belong to).
async function me(c: any): Promise<ProfileRow> {
  const [p] = await db.select().from(profiles).where(eq(profiles.id, c.var.auth.userId)).limit(1);
  if (!p) throw Errors.unauthorized("auth/no-profile", "Authenticated user has no profile");
  return p;
}

// The single connection row between two users in a project, in either direction.
async function between(projectId: string, a: string, b: string): Promise<ConnRow | null> {
  const [row] = await db.select().from(connections).where(and(
    eq(connections.projectId, projectId),
    or(
      and(eq(connections.requesterId, a), eq(connections.addresseeId, b)),
      and(eq(connections.requesterId, b), eq(connections.addresseeId, a))
    )
  )).limit(1);
  return row ?? null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function notify(projectId: string, recipientId: string, type: string, initiator: ProfileRow, connectionId: string) {
  await db.insert(appNotifications).values({
    projectId, userId: recipientId, type, action: "open-profile",
    metadata: { connectionId, initiatorId: initiator.id, initiatorName: initiator.name, initiatorUsername: initiator.username, initiatorAvatar: initiator.avatar },
  });
}

export const connectionRoutes = new Hono<{ Variables: Variables }>()
  // ── request / status / remove against a specific user ──────────────────────
  .post("/users/:userId/connection", requireAuth, async (c) => {
    const self = await me(c);
    const target = c.req.param("userId");
    if (target === self.id) throw Errors.badRequest("connections/self", "Cannot connect with yourself");
    const { message } = parseBody(connectionRequestSchema, await c.req.json().catch(() => ({})), "connections");
    const existing = await between(self.projectId, self.id, target);
    if (existing) {
      if (existing.status === "connected") throw Errors.conflict("connections/already-connected", "Already connected");
      if (existing.status === "pending") throw Errors.conflict("connections/already-pending", "A pending request already exists");
      // a prior declined row → reopen as a fresh pending request from self
      const [row] = await db.update(connections)
        .set({ requesterId: self.id, addresseeId: target, status: "pending", message, respondedAt: null, createdAt: new Date() })
        .where(eq(connections.id, existing.id)).returning();
      await notify(self.projectId, target, "connection-request", self, row!.id);
      return c.json({ id: row!.id, status: row!.status, createdAt: iso(row!.createdAt) });
    }
    const [row] = await db.insert(connections)
      .values({ projectId: self.projectId, requesterId: self.id, addresseeId: target, status: "pending", message })
      .returning();
    await notify(self.projectId, target, "connection-request", self, row!.id);
    return c.json({ id: row!.id, status: row!.status, createdAt: iso(row!.createdAt) }, 201);
  })
  .get("/users/:userId/connection", requireAuth, async (c) => {
    const self = await me(c);
    const row = await between(self.projectId, self.id, c.req.param("userId"));
    if (!row) return c.json({ status: "none" });
    if (row.status === "connected") {
      return c.json({ status: "connected", connectionId: row.id, connectedAt: iso(row.respondedAt), requestedAt: iso(row.createdAt) });
    }
    const type = row.requesterId === self.id ? "sent" : "received";
    if (row.status === "pending") return c.json({ status: "pending", type, connectionId: row.id, createdAt: iso(row.createdAt) });
    return c.json({ status: "declined", type, connectionId: row.id, respondedAt: iso(row.respondedAt) });
  })
  .delete("/users/:userId/connection", requireAuth, async (c) => {
    const self = await me(c);
    const row = await between(self.projectId, self.id, c.req.param("userId"));
    if (!row) throw Errors.notFound("connections/not-found", "No connection with this user");
    const action = row.status === "connected" ? "disconnect" : row.requesterId === self.id ? "withdraw" : "decline";
    await db.delete(connections).where(eq(connections.id, row.id));
    return c.json({ id: row.id, action, message: "Connection removed" });
  })
  .get("/users/:userId/connections-count", requireAuth, async (c) => {
    const self = await me(c);
    return c.json({ count: await connectedCount(self.projectId, c.req.param("userId")) });
  })
  // ── established + counts for the current user ───────────────────────────────
  .get("/connections", requireAuth, async (c) => {
    const self = await me(c);
    const { page, limit, offset } = readPagination(c);
    const where = and(eq(connections.projectId, self.projectId), eq(connections.status, "connected"),
      or(eq(connections.requesterId, self.id), eq(connections.addresseeId, self.id)));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(connections).where(where);
    const rows = await db.select().from(connections).where(where).orderBy(desc(connections.respondedAt)).limit(limit).offset(offset);
    const data = await Promise.all(rows.map(async (r) => {
      const otherId = r.requesterId === self.id ? r.addresseeId : r.requesterId;
      const [other] = await db.select().from(profiles).where(eq(profiles.id, otherId)).limit(1);
      return { id: r.id, connectedUser: other ? shapeUser(other) : null, connectedAt: iso(r.respondedAt) };
    }));
    return c.json(paginate(data, n, page, limit));
  })
  .get("/connections/count", requireAuth, async (c) => {
    const self = await me(c);
    return c.json({ count: await connectedCount(self.projectId, self.id) });
  })
  .get("/connections/pending/received", requireAuth, async (c) => {
    const self = await me(c);
    return c.json(await pendingList(c, self, "received"));
  })
  .get("/connections/pending/sent", requireAuth, async (c) => {
    const self = await me(c);
    return c.json(await pendingList(c, self, "sent"));
  })
  // ── accept / decline / withdraw a connection by id ──────────────────────────
  .patch("/connections/:id/accept", requireAuth, async (c) => {
    const self = await me(c);
    const [row] = await db.select().from(connections)
      .where(and(eq(connections.id, c.req.param("id")), eq(connections.addresseeId, self.id), eq(connections.status, "pending"))).limit(1);
    if (!row) throw Errors.notFound("connections/not-pending", "No pending request to accept");
    const [updated] = await db.update(connections).set({ status: "connected", respondedAt: new Date() }).where(eq(connections.id, row.id)).returning();
    await notify(self.projectId, row.requesterId, "connection-accepted", self, row.id);
    return c.json({ id: updated!.id, status: "connected", respondedAt: iso(updated!.respondedAt) });
  })
  .patch("/connections/:id/decline", requireAuth, async (c) => {
    const self = await me(c);
    const [row] = await db.update(connections).set({ status: "declined", respondedAt: new Date() })
      .where(and(eq(connections.id, c.req.param("id")), eq(connections.addresseeId, self.id), eq(connections.status, "pending"))).returning();
    if (!row) throw Errors.notFound("connections/not-pending", "No pending request to decline");
    return c.json({ id: row.id, status: "declined", respondedAt: iso(row.respondedAt) });
  })
  .delete("/connections/:id", requireAuth, async (c) => {
    const self = await me(c);
    const [row] = await db.select().from(connections)
      .where(and(eq(connections.id, c.req.param("id")),
        or(eq(connections.requesterId, self.id), eq(connections.addresseeId, self.id)))).limit(1);
    if (!row) throw Errors.notFound("connections/not-found", "Connection not found");
    await db.delete(connections).where(eq(connections.id, row.id));
    return c.json({ message: "Connection removed" });
  });

// ── shared ────────────────────────────────────────────────────────────────────
async function connectedCount(projectId: string, userId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(connections).where(and(
    eq(connections.projectId, projectId), eq(connections.status, "connected"),
    or(eq(connections.requesterId, userId), eq(connections.addresseeId, userId))
  ));
  return r?.n ?? 0;
}

async function pendingList(c: any, self: ProfileRow, kind: "received" | "sent") {
  const { page, limit, offset } = readPagination(c);
  const mineCol = kind === "received" ? connections.addresseeId : connections.requesterId;
  const otherCol = kind === "received" ? connections.requesterId : connections.addresseeId;
  const where = and(eq(connections.projectId, self.projectId), eq(connections.status, "pending"), eq(mineCol, self.id));
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(connections).where(where);
  const rows = await db.select().from(connections).where(where).orderBy(desc(connections.createdAt)).limit(limit).offset(offset);
  const data = await Promise.all(rows.map(async (r) => {
    const otherId = (r as any)[otherCol === connections.requesterId ? "requesterId" : "addresseeId"];
    const [other] = await db.select().from(profiles).where(eq(profiles.id, otherId)).limit(1);
    return { id: r.id, message: r.message ?? undefined, createdAt: iso(r.createdAt), user: other ? shapeUser(other) : null, type: kind };
  }));
  return paginate(data, n, page, limit);
}
