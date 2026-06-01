// Row → API model shaper (camelCase, Date→ISO), mirroring @agora/api's lib/shape.ts convention so
// the admin app receives the same envelope shape from either service.
import type { ModerationAnalysis, ModerationVerdict, ReportTargetType, UserSummary } from "@agora/contract";
import type { moderationAnalyses } from "../db/schema.js";

type AnalysisRow = typeof moderationAnalyses.$inferSelect;

export function shapeAnalysis(r: AnalysisRow, author?: UserSummary | null): ModerationAnalysis {
  return {
    id: r.id,
    projectId: r.projectId,
    targetType: r.targetType as ReportTargetType,
    targetId: r.targetId,
    spaceId: r.spaceId,
    verdict: r.verdict as ModerationVerdict,
    categories: r.categories,
    confidence: r.confidence,
    reason: r.reason,
    model: r.model,
    autoActioned: r.autoActioned,
    humanResolvedAt: r.humanResolvedAt ? r.humanResolvedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    ...(author !== undefined ? { author } : {}),
  };
}
