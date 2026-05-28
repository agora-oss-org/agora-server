// /v7/:projectId/reports/*
import { Hono } from "hono";
import { and, eq, isNotNull, desc, count } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { reports } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeReport } from "../lib/shape.js";
import { parseBody, createReportSchema } from "../lib/validation.js";

export const reportRoutes = new Hono<{ Variables: Variables }>()
  .post("/", requireAuth, async (c) => {
    const body = parseBody(createReportSchema, await c.req.json().catch(() => ({})), "reports");
    const [row] = await db.insert(reports).values({
      projectId: c.var.projectId,
      reporterId: c.var.auth!.userId,
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
      details: body.details,
      spaceId: body.spaceId,
    }).returning();
    return c.json(shapeReport(row!), 201);
  })
  // Resolved/moderated reports for the project (admin/moderation views).
  .get("/moderated", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const where = and(eq(reports.projectId, c.var.projectId), isNotNull(reports.resolvedAt));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(reports).where(where);
    const rows = await db.select().from(reports).where(where)
      .orderBy(desc(reports.resolvedAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map(shapeReport), n, page, limit));
  });
