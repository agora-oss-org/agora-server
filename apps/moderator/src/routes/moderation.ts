// Admin-facing review aids (operator-gated). The moderator carries its own version: the admin
// reaches these at /v1/:projectId/moderation/* with the same Bearer token it already holds.
//   GET  /config                             → the moderator's running configuration (secret-redacted)
//   GET  /stats                              → aggregate metrics (verdict counts, auto-blocks, tokens)
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
import { env } from "../lib/env.js";
import { buildRunningConfig } from "../lib/running-config.js";
import { db } from "../db/index.js";
import { moderationAnalyses } from "../db/schema.js";
import { loadAuthors } from "../lib/authors.js";
import { logger } from "../lib/logger.js";
import { shapeAnalysis } from "../lib/shape.js";
import { assessAndRecord } from "../lib/assess-and-record.js";
import { applyModeration, writeBackEnabled } from "../lib/api-client.js";
import { moderationReasonText } from "../lib/reason.js";

function readPagination(c: { req: { query: (k: string) => string | undefined } }) {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export const moderationRoutes = new Hono<{ Variables: Variables }>()
  .use("*", requireOperator)

  // GET /config — the moderator's running configuration (secret-redacted; operator-only via the
  // router gate above). The `defaults` block is the service's env config — projects can override it.
  .get("/config", (c) =>
    c.json({
      service: "agora-moderator",
      node: process.version,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      config: buildRunningConfig(env),
    })
  )

  // Aggregate metrics for the admin dashboard: how many moderations the service has created
  // (by verdict), how many it auto-removed, and the total LLM token usage — all-time for the project.
  .get("/stats", async (c) => {
    const projectId = c.req.param("projectId")!;
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        blocks: sql<number>`(count(*) filter (where ${moderationAnalyses.verdict} = 'block'))::int`,
        reviews: sql<number>`(count(*) filter (where ${moderationAnalyses.verdict} = 'review'))::int`,
        allows: sql<number>`(count(*) filter (where ${moderationAnalyses.verdict} = 'allow'))::int`,
        autoBlocks: sql<number>`(count(*) filter (where ${moderationAnalyses.autoActioned}))::int`,
        promptTokens: sql<number>`coalesce(sum(${moderationAnalyses.promptTokens}), 0)::bigint`,
        completionTokens: sql<number>`coalesce(sum(${moderationAnalyses.completionTokens}), 0)::bigint`,
      })
      .from(moderationAnalyses)
      .where(eq(moderationAnalyses.projectId, projectId));
    const promptTokens = Number(row?.promptTokens ?? 0);
    const completionTokens = Number(row?.completionTokens ?? 0);
    return c.json({
      total: row?.total ?? 0,
      blocks: row?.blocks ?? 0,
      reviews: row?.reviews ?? 0,
      allows: row?.allows ?? 0,
      autoBlocks: row?.autoBlocks ?? 0,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });
  })

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
    const authorByTarget = await loadAuthors(rows);
    const data = rows.map((r) => shapeAnalysis(r, authorByTarget.get(r.targetId) ?? null));
    return c.json(paginate(data, countRows[0]?.count ?? 0, page, limit));
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
    logger.info(
      { projectId, operatorId: c.var.auth?.userId, targetType: b.targetType, targetId: b.targetId },
      "moderation: on-demand analyze requested",
    );
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
    logger.info(
      { projectId, operatorId: c.var.auth?.userId, analysisId: id, targetType: row.targetType, targetId: row.targetId },
      "moderation: flag dismissed by operator",
    );
    return c.json(shapeAnalysis(row));
  })

  // Confirm an AI flag: remove the content (write-back to the API) and clear it from the queue.
  // Accepts an optional { reason } — the human's note overrides the AI's stored reason on the removal.
  .post("/:id/remove", async (c) => {
    const projectId = c.req.param("projectId")!;
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const humanReason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
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
      // Human note wins as-is; otherwise carry the AI verdict + score into the stored reason.
      reason: humanReason || moderationReasonText(analysis),
    });
    if (!ok) throw Errors.unavailable("moderation/writeback-failed", "Failed to apply removal");
    const [row] = await db
      .update(moderationAnalyses)
      .set({ humanResolvedAt: new Date(), autoActioned: true })
      .where(eq(moderationAnalyses.id, id))
      .returning();
    logger.info(
      {
        projectId, operatorId: c.var.auth?.userId, analysisId: id,
        targetType: analysis.targetType, targetId: analysis.targetId,
        verdict: analysis.verdict, confidence: analysis.confidence, humanReason: !!humanReason,
      },
      "moderation: content removed by operator",
    );
    return c.json(shapeAnalysis(row!));
  });
