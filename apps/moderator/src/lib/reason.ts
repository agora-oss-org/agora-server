// Formats the moderationReason the moderator writes back to the API so the stored reason carries the
// LLM's verdict + confidence score inline — e.g. "AI review (60% confidence): <the model's reason>".
// Used on both write-back paths (auto-action + human-confirmed removal). The score is what the admin
// and operators see on the removed content, so it travels with the decision rather than being lost.
export function moderationReasonText(input: { verdict: string; confidence: number; reason?: string | null }): string {
  const pct = Math.round((Number.isFinite(input.confidence) ? input.confidence : 0) * 100);
  const head = `AI ${input.verdict} (${pct}% confidence)`;
  const body = (input.reason ?? "").trim();
  return body ? `${head}: ${body}` : head;
}
