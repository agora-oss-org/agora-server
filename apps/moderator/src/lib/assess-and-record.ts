// The moderation pipeline shared by the webhook receiver and the admin on-demand /analyze endpoint:
//   1. run the LLM classifier (assess)
//   2. auto-act when confident: verdict==="block" && confidence >= threshold && write-back is wired
//      → POST the removal back to the API (moderatedByType="client")
//   3. persist one moderation_analyses row (the audit trail + AI-flag queue)
import type { ModerationAnalysis, ReportTargetType } from "@agora/contract";
import { db } from "../db/index.js";
import { moderationAnalyses } from "../db/schema.js";
import { logger } from "./logger.js";
import { assess } from "./llm-provider.js";
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
  const verdict = await assess({ text: t.text, context: t.context }, config.llm);

  // Auto-action: only entity/comment are writable back through the API, and only above the
  // configured confidence threshold (0 disables it entirely → everything queues for a human).
  let autoActioned = false;
  const eligible =
    verdict.verdict === "block" &&
    config.autoActionThreshold > 0 &&
    verdict.confidence >= config.autoActionThreshold &&
    (t.targetType === "entity" || t.targetType === "comment");
  if (eligible && writeBackEnabled()) {
    autoActioned = await applyModeration({
      projectId: t.projectId,
      targetType: t.targetType as "entity" | "comment",
      targetId: t.targetId,
      status: "removed",
      reason: moderationReasonText(verdict), // carries the LLM verdict + score into the stored reason
    });
    if (autoActioned) logger.warn({ targetType: t.targetType, targetId: t.targetId, confidence: verdict.confidence }, "auto-removed content");
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
    })
    .returning();
  return shapeAnalysis(row!);
}
