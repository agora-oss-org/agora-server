// /v7/:projectId/app-notifications/*  — the authenticated user's inbox.
import { Hono } from "hono";
import { and, eq, count, desc } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { appNotifications } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeNotification } from "../lib/shape.js";

export const notificationRoutes = new Hono<{ Variables: Variables }>()
  .get("/", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const where = and(eq(appNotifications.projectId, c.var.projectId), eq(appNotifications.userId, c.var.auth!.userId));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(appNotifications).where(where);
    const rows = await db.select().from(appNotifications).where(where)
      .orderBy(desc(appNotifications.createdAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map(shapeNotification), n, page, limit));
  })
  .get("/count", requireAuth, async (c) => {
    const [r] = await db.select({ n: count() }).from(appNotifications).where(and(
      eq(appNotifications.projectId, c.var.projectId),
      eq(appNotifications.userId, c.var.auth!.userId),
      eq(appNotifications.isRead, false)
    ));
    return c.json({ count: r?.n ?? 0 });
  })
  .post("/mark-all-as-read", requireAuth, async (c) => {
    await db.update(appNotifications).set({ isRead: true }).where(and(
      eq(appNotifications.projectId, c.var.projectId),
      eq(appNotifications.userId, c.var.auth!.userId),
      eq(appNotifications.isRead, false)
    ));
    return c.json({ success: true });
  })
  .patch("/:id/mark-as-read", requireAuth, async (c) => {
    const [row] = await db.update(appNotifications).set({ isRead: true }).where(and(
      eq(appNotifications.projectId, c.var.projectId),
      eq(appNotifications.userId, c.var.auth!.userId),
      eq(appNotifications.id, c.req.param("id"))
    )).returning();
    if (!row) return c.json({ success: false }, 404);
    return c.json(shapeNotification(row));
  });
