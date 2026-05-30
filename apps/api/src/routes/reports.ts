// /v7/:projectId/reports/*
import { Hono } from "hono";
import { and, eq, isNull, isNotNull, desc, count, inArray } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { reports, spaces, spaceMembers } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeReport } from "../lib/shape.js";
import { parseBody, createReportSchema } from "../lib/validation.js";

// The set of space ids a user may moderate: spaces they own (space.userId) + memberships with an
// active admin/moderator role. Used to scope the pending-reports queue for non-operators.
async function moderatedSpaceIds(projectId: string, userId: string): Promise<string[]> {
  const [owned, member] = await Promise.all([
    db.select({ id: spaces.id }).from(spaces)
      .where(and(eq(spaces.projectId, projectId), eq(spaces.userId, userId), isNull(spaces.deletedAt))),
    db.select({ id: spaceMembers.spaceId }).from(spaceMembers)
      .where(and(
        eq(spaceMembers.projectId, projectId), eq(spaceMembers.userId, userId),
        eq(spaceMembers.status, "active"), inArray(spaceMembers.role, ["admin", "moderator"]),
      )),
  ]);
  return [...new Set([...owned.map((r) => r.id), ...member.map((r) => r.id)])];
}

// Narrow a base report condition to what the caller may see: operators see everything; everyone
// else is limited to reports in spaces they moderate. `empty: true` means "no visible reports"
// (a non-operator who moderates nothing) — the caller should short-circuit to an empty page.
async function scopeReports(c: any, base: ReturnType<typeof and>): Promise<{ where: ReturnType<typeof and>; empty: boolean }> {
  if (c.var.auth.isOperator) return { where: base, empty: false };
  const spaceIds = await moderatedSpaceIds(c.var.projectId, c.var.auth.userId);
  if (spaceIds.length === 0) return { where: base, empty: true };
  return { where: and(base, inArray(reports.spaceId, spaceIds)), empty: false };
}

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
  // Open (unresolved) reports — the moderation inbox. A deployment operator sees every unresolved
  // report in the project (incl. project-level reports with no space); a normal user sees only those
  // filed against content in spaces they own or moderate. Newest first.
  .get("/pending", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const { where, empty } = await scopeReports(c, and(eq(reports.projectId, c.var.projectId), isNull(reports.resolvedAt)));
    if (empty) return c.json(paginate([], 0, page, limit));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(reports).where(where);
    const rows = await db.select().from(reports).where(where)
      .orderBy(desc(reports.createdAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map(shapeReport), n, page, limit));
  })
  // Resolved/moderated reports — same role scope as the pending queue. Most-recently-resolved first.
  .get("/moderated", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const { where, empty } = await scopeReports(c, and(eq(reports.projectId, c.var.projectId), isNotNull(reports.resolvedAt)));
    if (empty) return c.json(paginate([], 0, page, limit));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(reports).where(where);
    const rows = await db.select().from(reports).where(where)
      .orderBy(desc(reports.resolvedAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map(shapeReport), n, page, limit));
  });
