// Admin-facing review aids (operator-gated). The moderator carries its own version: the admin
// reaches these at /v1/:projectId/moderation/* with the same Bearer token it already holds.
//   GET  /queue                              → the AI-flag queue (unresolved block/review analyses)
//   GET  /analysis?targetType=&targetId=     → the latest stored analysis for one item
//   POST /analyze                            → on-demand (re)assessment (admin "Re-analyze")
//   POST /:id/resolve                        → mark an analysis human-resolved (clears it from queue)
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { moderationAnalyzeSchema, paginate } from "@agora/contract";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireOperator } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { moderationAnalyses } from "../db/schema.js";
import { shapeAnalysis } from "../lib/shape.js";
import { assessAndRecord } from "../lib/assess-and-record.js";
import { applyModeration, writeBackEnabled } from "../lib/api-client.js";

function readPagination(c: { req: { query: (k: string) => string | undefined } }) {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export const moderationRoutes = new Hono<{ Variables: Variables }>()
  .use("*", requireOperator)

  // The AI-flag queue: unresolved block/review analyses for the project (optionally one space).
  .get("/queue", async (c) => {
    const projectId = c.req.param("projectId")!;
    const { page, limit, offset } = readPagination(c);
    const spaceId = c.req.query("spaceId");
    const where = and(
      eq(moderationAnalyses.projectId, projectId),
      isNull(moderationAnalyses.humanResolvedAt),
      inArray(moderationAnalyses.verdict, ["block", "review"]),
      ...(spaceId ? [eq(moderationAnalyses.spaceId, spaceId)] : [])
    );
    const [rows, countRows] = await Promise.all([
      db.select().from(moderationAnalyses).where(where).orderBy(desc(moderationAnalyses.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(moderationAnalyses).where(where),
    ]);
    return c.json(paginate(rows.map(shapeAnalysis), countRows[0]?.count ?? 0, page, limit));
  })

  // Latest stored analysis for one piece of content (shown in the admin ReviewDialog).
  .get("/analysis", async (c) => {
    const projectId = c.req.param("projectId")!;
    const targetType = c.req.query("targetType");
    const targetId = c.req.query("targetId");
    if (!targetType || !targetId) throw Errors.badRequest("moderation/missing-target", "targetType and targetId are required");
    const [row] = await db
      .select()
      .from(moderationAnalyses)
      .where(and(eq(moderationAnalyses.projectId, projectId), eq(moderationAnalyses.targetType, targetType as any), eq(moderationAnalyses.targetId, targetId)))
      .orderBy(desc(moderationAnalyses.createdAt))
      .limit(1);
    return c.json({ analysis: row ? shapeAnalysis(row) : null });
  })

  // On-demand (re)assessment: the admin passes the content text it already has loaded.
  .post("/analyze", async (c) => {
    const projectId = c.req.param("projectId")!;
    const parsed = moderationAnalyzeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw Errors.badRequest("moderation/invalid-body", first?.message ?? "Invalid body", first?.path.join("."));
    }
    const b = parsed.data;
    const analysis = await assessAndRecord({
      projectId,
      targetType: b.targetType,
      targetId: b.targetId,
      spaceId: b.spaceId ?? null,
      text: b.text,
      context: b.context,
    });
    return c.json(analysis);
  })

  // Dismiss an AI flag: clear it from the queue without touching the content (false positive / fine).
  .post("/:id/resolve", async (c) => {
    const projectId = c.req.param("projectId")!;
    const id = c.req.param("id");
    const [row] = await db
      .update(moderationAnalyses)
      .set({ humanResolvedAt: new Date() })
      .where(and(eq(moderationAnalyses.id, id), eq(moderationAnalyses.projectId, projectId)))
      .returning();
    if (!row) throw Errors.notFound("moderation/analysis-not-found", "Analysis not found");
    return c.json(shapeAnalysis(row));
  })

  // Confirm an AI flag: remove the content (write-back to the API) and clear it from the queue.
  .post("/:id/remove", async (c) => {
    const projectId = c.req.param("projectId")!;
    const id = c.req.param("id");
    const [analysis] = await db
      .select()
      .from(moderationAnalyses)
      .where(and(eq(moderationAnalyses.id, id), eq(moderationAnalyses.projectId, projectId)))
      .limit(1);
    if (!analysis) throw Errors.notFound("moderation/analysis-not-found", "Analysis not found");
    if (analysis.targetType !== "entity" && analysis.targetType !== "comment")
      throw Errors.badRequest("moderation/not-removable", "Only entities and comments can be removed");
    if (!writeBackEnabled())
      throw Errors.unavailable("moderation/writeback-disabled", "Content write-back is not configured");
    const ok = await applyModeration({
      projectId,
      targetType: analysis.targetType,
      targetId: analysis.targetId,
      status: "removed",
      reason: analysis.reason || "Confirmed by moderator",
    });
    if (!ok) throw Errors.unavailable("moderation/writeback-failed", "Failed to apply removal");
    const [row] = await db
      .update(moderationAnalyses)
      .set({ humanResolvedAt: new Date(), autoActioned: true })
      .where(eq(moderationAnalyses.id, id))
      .returning();
    return c.json(shapeAnalysis(row!));
  });
