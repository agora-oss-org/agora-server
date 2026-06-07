// The auto-action decision: given an LLM verdict + confidence and a project's two confidence floors,
// decide whether to auto-remove the content and which verdict triggered it. Pure (no DB, no LLM) so
// the decision table is unit-tested in isolation (auto-action.test.ts).
//
// Two independent floors let an operator tune block and review separately:
//   - blockAutoActionThreshold  — auto-remove a "block" verdict at/above this confidence
//   - reviewAutoActionThreshold — auto-remove a "review" verdict at/above this confidence
// A floor of 0 disables that path entirely (the verdict routes to the human AI-flag queue instead).
// Only entity/comment are removable through the API write-back; messages always queue.
import type { ModerationVerdict, ReportTargetType } from "@agora-server/contract";

export interface AutoActionThresholds {
  blockAutoActionThreshold: number;
  reviewAutoActionThreshold: number;
}

// Which floor fired — surfaced in the verdict log + carried into the write-back reason; null = queue.
export type AutoActionTrigger = "block" | "review" | null;

export function decideAutoAction(
  verdict: ModerationVerdict,
  confidence: number,
  targetType: ReportTargetType,
  thresholds: AutoActionThresholds,
): AutoActionTrigger {
  const removable = targetType === "entity" || targetType === "comment";
  if (!removable) return null;
  if (verdict === "block" && thresholds.blockAutoActionThreshold > 0 && confidence >= thresholds.blockAutoActionThreshold) {
    return "block";
  }
  if (verdict === "review" && thresholds.reviewAutoActionThreshold > 0 && confidence >= thresholds.reviewAutoActionThreshold) {
    return "review";
  }
  return null;
}
