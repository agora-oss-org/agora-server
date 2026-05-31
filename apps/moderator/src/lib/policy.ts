// The moderation policy: the category taxonomy + the system prompt that pins the LLM to a strict
// JSON contract. Kept separate from the provider transport (llm-provider.ts) so the policy can be
// tuned without touching the HTTP adapters, and so it's trivially unit-testable.

// Categories the model may cite. Free-form strings are tolerated downstream, but steering the model
// toward a fixed set keeps the admin queue filterable.
export const MODERATION_CATEGORIES = [
  "harassment", // bullying, threats, targeted abuse
  "hate", // slurs, dehumanization of protected groups
  "sexual", // explicit sexual content; "sexual-minors" is always block
  "violence", // graphic violence, incitement
  "self-harm", // promotion/instructions of self-harm
  "spam", // scams, repetitive promotional junk
  "illicit", // instructions for serious wrongdoing (weapons, drugs, fraud)
  "pii", // doxxing / exposed personal data
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

// The contract we force the model to emit. We ask for STRICT JSON (no prose) so both provider
// adapters can parse a single object. verdict semantics:
//   allow  — clean / within policy
//   block  — clearly violates policy (eligible for auto-removal above the confidence threshold)
//   review — uncertain or context-dependent; always routes to a human
export const SYSTEM_PROMPT = `You are a content-moderation classifier for an online community.
Judge the USER content against this policy and respond with a SINGLE JSON object — no markdown, no
prose, no code fences.

Categories: ${MODERATION_CATEGORIES.join(", ")}.

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

// The user-message body. Context (e.g. the parent entity a comment replies to) is optional.
export function buildUserPrompt(input: { text: string; context?: string }): string {
  const ctx = input.context?.trim();
  return ctx
    ? `CONTEXT (the content this is replying to, for reference only — do not moderate it):\n${ctx}\n\nCONTENT TO MODERATE:\n${input.text}`
    : `CONTENT TO MODERATE:\n${input.text}`;
}
