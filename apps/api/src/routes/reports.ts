// /v7/:projectId/reports/*
import { Hono } from "hono";
import { and, eq, isNull, isNotNull, desc, count, inArray } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { reports, spaces, spaceMembers, entities, comments } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeReport, loadReportParticipants } from "../lib/shape.js";
import { parseBody, createReportSchema } from "../lib/validation.js";
import { Errors } from "../http/errors.js";
import { isProjectAdmin, requireProjectAdmin } from "../lib/project-roles.js";

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
  if (isProjectAdmin(c.var.auth)) return { where: base, empty: false };
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
    logger.info({ projectId: c.var.projectId, reportId: row!.id, reporterId: c.var.auth!.userId, targetType: body.targetType, targetId: body.targetId, spaceId: body.spaceId ?? null, reason: body.reason }, "report: filed");
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
    const { authorByReport, reporterByReport } = await loadReportParticipants(c.var.projectId, rows);
    const data = rows.map((r) => shapeReport(r, { author: authorByReport.get(r.id), reporter: reporterByReport.get(r.id) }));
    return c.json(paginate(data, n, page, limit));
  })
  // Resolved/moderated reports — same role scope as the pending queue. Most-recently-resolved first.
  .get("/moderated", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const { where, empty } = await scopeReports(c, and(eq(reports.projectId, c.var.projectId), isNotNull(reports.resolvedAt)));
    if (empty) return c.json(paginate([], 0, page, limit));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(reports).where(where);
    const rows = await db.select().from(reports).where(where)
      .orderBy(desc(reports.resolvedAt)).limit(limit).offset(offset);
    const { authorByReport, reporterByReport } = await loadReportParticipants(c.var.projectId, rows);
    const data = rows.map((r) => shapeReport(r, { author: authorByReport.get(r.id), reporter: reporterByReport.get(r.id) }));
    return c.json(paginate(data, n, page, limit));
  })
  // Operator-only: action a report by id, regardless of space. The space-scoped flow
  // (PATCH /spaces/:id/.../moderation + /spaces/:id/reports/...) needs a spaceId, so PROJECT-LEVEL
  // reports (no space) can't be resolved there. Operators have the project-wide god-view, so they
  // moderate the target + resolve the report here in one call. action: removed | approved | dismiss
  // (dismiss resolves without touching the content). Mirrors the space moderation fields exactly.
  .patch("/:id/resolve", requireAuth, async (c) => {
    requireProjectAdmin(c);
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; reason?: string };
    if (body.action !== "removed" && body.action !== "approved" && body.action !== "dismiss") {
      throw Errors.badRequest("reports/invalid-action", "action must be removed, approved, or dismiss", "action");
    }
    const action = body.action as "removed" | "approved" | "dismiss"; // validated above
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason : undefined;

    const [report] = await db.select().from(reports)
      .where(and(eq(reports.projectId, c.var.projectId), eq(reports.id, c.req.param("id")))).limit(1);
    if (!report) throw Errors.notFound("reports/not-found", "Report not found");

    if (action !== "dismiss") {
      const mod = {
        moderationStatus: action, moderationReason: reason, moderatedAt: new Date(),
        moderatedById: c.var.auth!.userId, moderatedByType: "user" as const,
      };
      if (report.targetType === "entity") {
        await db.update(entities).set(mod).where(and(eq(entities.projectId, c.var.projectId), eq(entities.id, report.targetId)));
      } else if (report.targetType === "comment") {
        await db.update(comments).set(mod).where(and(eq(comments.projectId, c.var.projectId), eq(comments.id, report.targetId)));
      }
    }
    await db.update(reports).set({ resolvedAt: new Date(), resolvedById: c.var.auth!.userId })
      .where(and(eq(reports.projectId, c.var.projectId), eq(reports.id, report.id)));
    logger.info({ projectId: c.var.projectId, reportId: report.id, operatorId: c.var.auth!.userId, action, targetType: report.targetType, targetId: report.targetId }, "report: resolved by operator");
    return c.json({ success: true });
  });
