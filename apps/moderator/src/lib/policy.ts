// The moderation policy: the system prompt that pins the LLM to a strict JSON contract. Kept separate
// from the provider transport (llm-provider.ts) so the policy can be tuned without touching the HTTP
// adapters, and so it's trivially unit-testable.
//
// Categories are PER-PROJECT now: the starting list is DEFAULT_MODERATION_CATEGORIES (shared in
// @agora-server/contract), seeded into projects.moderator_config.categories and editable in admin Settings →
// Agent moderation. The moderator resolves the project's list (lib/project-config.ts) and passes it to
// buildSystemPrompt(), so the prompt lists exactly the categories the operator configured.
import { DEFAULT_MODERATION_CATEGORIES } from "@agora-server/contract";

// Re-export the seed list so the rest of the moderator (and the project-config fallback) has one source.
export { DEFAULT_MODERATION_CATEGORIES };

// The contract we force the model to emit. We ask for STRICT JSON (no prose) so both provider
// adapters can parse a single object. verdict semantics:
//   allow  — clean / within policy
//   block  — clearly violates policy (eligible for auto-removal above the confidence threshold)
//   review — uncertain or context-dependent; always routes to a human
export function buildSystemPrompt(categories: readonly string[]): string {
  const list = (categories.length ? categories : DEFAULT_MODERATION_CATEGORIES).join(", ");
  return `You are a content-moderation classifier for an online community.
Judge the USER content against this policy and respond with a SINGLE JSON object — no markdown, no
prose, no code fences.

Categories: ${list}.

Output schema (all fields required):
{
  "verdict": "allow" | "block" | "review",
  "categories": string[],   // subset of the categories above; [] when verdict is "allow"
  "confidence": number,     // 0..1, your certainty in the verdict
  "reason": string          // one concise sentence explaining the decision
}

Rules:
- "block" only when the content clearly violates policy. Use "review" when it is borderline,
  sarcastic, ambiguous, or depends on context you lack.
- Any sexual content involving minors is always "block" with confidence 1.
- Do not moralize or add commentary. Output ONLY the JSON object.`;
}

// The user-message body. Context (e.g. the parent entity a comment replies to) is optional.
export function buildUserPrompt(input: { text: string; context?: string }): string {
  const ctx = input.context?.trim();
  return ctx
    ? `CONTEXT (the content this is replying to, for reference only — do not moderate it):\n${ctx}\n\nCONTENT TO MODERATE:\n${input.text}`
    : `CONTENT TO MODERATE:\n${input.text}`;
}
