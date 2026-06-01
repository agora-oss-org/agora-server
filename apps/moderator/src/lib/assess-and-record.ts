// The moderation pipeline shared by the webhook receiver and the admin on-demand /analyze endpoint:
//   1. run the LLM classifier (assess)
//   2. auto-act when confident: a "block" verdict clears the block threshold, or a "review" verdict
//      clears the (opt-in) review threshold (decideAutoAction), and write-back is wired
//      → POST the removal back to the API (moderatedByType="client")
//   3. persist one moderation_analyses row (the audit trail + AI-flag queue)
import type { ModerationAnalysis, ReportTargetType } from "@agora/contract";
import { db } from "../db/index.js";
import { moderationAnalyses } from "../db/schema.js";
import { logger } from "./logger.js";
import { assess } from "./llm-provider.js";
import { decideAutoAction } from "./auto-action.js";
import { getModeratorConfig } from "./project-config.js";
import { applyModeration, writeBackEnabled } from "./api-client.js";
import { moderationReasonText } from "./reason.js";
import { shapeAnalysis } from "./shape.js";

export interface AssessTarget {
  projectId: string;
  targetType: ReportTargetType; // entity | comment | message
  targetId: string;
  spaceId?: string | null;
  text: string;
  context?: string;
}

export async function assessAndRecord(t: AssessTarget): Promise<ModerationAnalysis> {
  const config = await getModeratorConfig(t.projectId); // per-project tuning over env defaults
  logger.debug(
    {
      projectId: t.projectId, targetType: t.targetType, targetId: t.targetId, spaceId: t.spaceId ?? null,
      textLength: t.text.length, hasContext: !!t.context,
      provider: config.llm.provider, model: config.llm.model,
      blockThreshold: config.blockAutoActionThreshold, reviewThreshold: config.reviewAutoActionThreshold,
    },
    "moderation: assessing content",
  );

  const startedAt = Date.now();
  const verdict = await assess({ text: t.text, context: t.context }, config.llm, config.categories);
  const latencyMs = Date.now() - startedAt;

  // Auto-action: only entity/comment are writable back through the API, and only when a verdict
  // clears its confidence floor (block or the opt-in review threshold; 0 disables a path → queue).
  let autoActioned = false;
  const autoActionVerdict = decideAutoAction(verdict.verdict, verdict.confidence, t.targetType, config);
  const eligible = autoActionVerdict !== null;

  // The headline log: the LLM's decision + score for this exact item, plus everything an operator
  // needs to trace it (project, target id/type, space, categories, model, thresholds, latency).
  logger.info(
    {
      projectId: t.projectId, targetType: t.targetType, targetId: t.targetId, spaceId: t.spaceId ?? null,
      verdict: verdict.verdict, confidence: verdict.confidence, scorePct: Math.round(verdict.confidence * 100),
      categories: verdict.categories, model: verdict.model,
      promptTokens: verdict.promptTokens, completionTokens: verdict.completionTokens,
      blockThreshold: config.blockAutoActionThreshold, reviewThreshold: config.reviewAutoActionThreshold,
      eligibleForAutoRemoval: eligible, autoActionVerdict, llmLatencyMs: latencyMs,
    },
    "moderation: verdict",
  );

  if (eligible && writeBackEnabled()) {
    autoActioned = await applyModeration({
      projectId: t.projectId,
      targetType: t.targetType as "entity" | "comment",
      targetId: t.targetId,
      status: "removed",
      reason: moderationReasonText(verdict), // carries the LLM verdict + score into the stored reason
    });
    logger.info(
      { projectId: t.projectId, targetType: t.targetType, targetId: t.targetId, confidence: verdict.confidence, autoActioned },
      autoActioned ? "moderation: auto-removed content" : "moderation: auto-removal write-back failed",
    );
  } else if (eligible) {
    logger.warn(
      { projectId: t.projectId, targetType: t.targetType, targetId: t.targetId },
      "moderation: eligible for auto-removal but write-back is not configured — queuing for a human",
    );
  }

  const [row] = await db
    .insert(moderationAnalyses)
    .values({
      projectId: t.projectId,
      targetType: t.targetType,
      targetId: t.targetId,
      spaceId: t.spaceId ?? null,
      verdict: verdict.verdict,
      categories: verdict.categories,
      confidence: verdict.confidence,
      reason: verdict.reason,
      model: verdict.model,
      autoActioned,
      promptTokens: verdict.promptTokens,
      completionTokens: verdict.completionTokens,
    })
    .returning();
  logger.debug(
    { analysisId: row?.id, projectId: t.projectId, targetType: t.targetType, targetId: t.targetId, autoActioned },
    "moderation: analysis recorded",
  );
  return shapeAnalysis(row!);
}
