// Generic LLM client: one interface, two fetch-based adapters (no SDK dep, mirroring the lean
// fetch style of @agora/api's lib/llm.ts + embeddings.ts). Non-streaming — we want a single
// structured verdict, not a token stream. The provider is chosen by env (MODERATOR_LLM_PROVIDER).
//
//   openai    → POST {base}/chat/completions   (OpenAI-compatible: OpenAI, Groq, Together,
//               OpenRouter, Ollama, vLLM, LM Studio … point MODERATOR_LLM_BASE_URL at the host)
//   anthropic → POST {base}/v1/messages
//
// Both are coerced to the same { verdict, categories, confidence, reason } shape via policy.ts.
import type { ModerationVerdict } from "@agora/contract";
import { env } from "./env.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./policy.js";

export interface AssessResult {
  verdict: ModerationVerdict;
  categories: string[];
  confidence: number;
  reason: string;
  model: string; // "provider:model" — recorded on each analysis row
}

const DEFAULT_BASE: Record<"openai" | "anthropic", string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};
const ANTHROPIC_VERSION = "2023-06-01";

/** True when an API key is configured. When false, callers should skip assessment (no-op). */
export function moderationEnabled(): boolean {
  return !!env.MODERATOR_LLM_API_KEY;
}

function baseUrl(): string {
  return (env.MODERATOR_LLM_BASE_URL ?? DEFAULT_BASE[env.MODERATOR_LLM_PROVIDER]).replace(/\/+$/, "");
}

/**
 * Run the policy classifier over a piece of content. Throws if the LLM isn't configured or the
 * provider returns a non-2xx / unparseable response.
 */
export async function assess(input: { text: string; context?: string }): Promise<AssessResult> {
  if (!env.MODERATOR_LLM_API_KEY) throw new Error("MODERATOR_LLM_API_KEY not configured");
  const user = buildUserPrompt(input);
  const raw =
    env.MODERATOR_LLM_PROVIDER === "anthropic"
      ? await callAnthropic(user)
      : await callOpenAI(user);
  return { ...parseVerdict(raw), model: `${env.MODERATOR_LLM_PROVIDER}:${env.MODERATOR_LLM_MODEL}` };
}

// ─── OpenAI-compatible /chat/completions ──────────────────────────────────────
async function callOpenAI(userPrompt: string): Promise<string> {
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MODERATOR_LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.MODERATOR_LLM_MODEL,
      max_tokens: env.MODERATOR_LLM_MAX_TOKENS,
      temperature: 0,
      // Ask for a JSON object. Hosts that don't support response_format ignore it; the system prompt
      // still pins the output to JSON, and parseVerdict() is tolerant.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content");
  return content;
}

// ─── Anthropic /v1/messages ───────────────────────────────────────────────────
async function callAnthropic(userPrompt: string): Promise<string> {
  const res = await fetch(`${baseUrl()}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": env.MODERATOR_LLM_API_KEY!,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.MODERATOR_LLM_MODEL,
      max_tokens: env.MODERATOR_LLM_MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = json.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("LLM returned no content");
  return text;
}

// ─── Tolerant JSON parse → normalized verdict ─────────────────────────────────
const VERDICTS: ModerationVerdict[] = ["allow", "block", "review"];

export function parseVerdict(raw: string): Omit<AssessResult, "model"> {
  // Strip code fences and isolate the first {...} object so we survive stray prose.
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error(`LLM output not JSON: ${raw.slice(0, 200)}`);
  let obj: any;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error(`LLM output not parseable JSON: ${raw.slice(0, 200)}`);
  }

  const verdict: ModerationVerdict = VERDICTS.includes(obj.verdict) ? obj.verdict : "review";
  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter((x: unknown): x is string => typeof x === "string")
    : [];
  let confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return { verdict, categories, confidence, reason };
}
