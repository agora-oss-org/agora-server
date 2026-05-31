// Data access for the @agora/moderator service (LLM moderation). Reuses the shared api() client with
// a base override (MODERATOR_BASE) so the operator's Bearer token + single-flight refresh come along
// for free. Endpoints mirror the moderator's /v7/:projectId/moderation/* routes.
import type { Entity, Comment, ModerationAnalysis, PaginatedResponse, ReportTargetType } from "@agora/contract";
import { api } from "./api";
import { MODERATOR_BASE } from "../config";

export const aiQueueKey = (page: number) => ["ai-queue", page] as const;
export const aiAnalysisKey = (targetType: string, targetId: string) => ["ai-analysis", targetType, targetId] as const;

/** The AI-flag queue: unresolved block/review verdicts awaiting human disposition. */
export function listAiQueue(page: number) {
  return api<PaginatedResponse<ModerationAnalysis>>(`/moderation/queue`, { base: MODERATOR_BASE, query: { page } });
}

/** Latest stored analysis for one piece of content (shown in the ReviewDialog AI panel). */
export function getAnalysis(targetType: ReportTargetType, targetId: string) {
  return api<{ analysis: ModerationAnalysis | null }>(`/moderation/analysis`, {
    base: MODERATOR_BASE,
    query: { targetType, targetId },
  }).then((r) => r.analysis);
}

/** On-demand (re)assessment. We send the text the admin already has loaded for the target. */
export function analyzeTarget(input: {
  targetType: ReportTargetType;
  targetId: string;
  spaceId?: string | null;
  text: string;
  context?: string;
}) {
  return api<ModerationAnalysis>(`/moderation/analyze`, { base: MODERATOR_BASE, method: "POST", body: input });
}

/** Dismiss an AI flag: clear it from the queue without touching the content. */
export function dismissAnalysis(id: string) {
  return api<ModerationAnalysis>(`/moderation/${id}/resolve`, { base: MODERATOR_BASE, method: "POST" });
}

/** Confirm an AI flag: remove the content (write-back to the API) and clear it from the queue. */
export function removeFlagged(id: string) {
  return api<ModerationAnalysis>(`/moderation/${id}/remove`, { base: MODERATOR_BASE, method: "POST" });
}

// Extract the moderatable text from a loaded target, mirroring the moderator's webhook extractor so
// an on-demand re-analysis matches what the automated path would have judged.
export function targetText(targetType: ReportTargetType, target: Entity | Comment | null): string {
  if (!target) return "";
  if (targetType === "entity") {
    const e = target as Entity;
    return [e.title, e.content].filter(Boolean).join("\n\n").trim();
  }
  return ((target as Comment).content ?? "").toString().trim();
}
