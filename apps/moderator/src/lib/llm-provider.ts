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
import { logger } from "./logger.js";
import { buildSystemPrompt, buildUserPrompt, DEFAULT_MODERATION_CATEGORIES } from "./policy.js";

export interface ParsedVerdict {
  verdict: ModerationVerdict;
  categories: string[];
  confidence: number;
  reason: string;
}

export interface AssessResult extends ParsedVerdict {
  model: string; // "provider:model" — recorded on each analysis row
  promptTokens: number; // provider-reported usage (0 when the host omits it)
  completionTokens: number;
}

// What an adapter hands back: the raw text to parse + the provider's token usage for the call.
interface LlmResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

// The provider settings one assessment runs with. Per-project overrides (admin Settings → Moderator)
// are merged over the env defaults in lib/project-config.ts; the env-only default lives in envLlm().
export interface LlmConfig {
  provider: "openai" | "anthropic";
  baseUrl?: string;     // unset → DEFAULT_BASE[provider]
  apiKey?: string;      // unset → not enabled (assess throws)
  model: string;
  maxTokens: number;
}

const DEFAULT_BASE: Record<"openai" | "anthropic", string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};
const ANTHROPIC_VERSION = "2023-06-01";

/** The provider config from env alone (the fallback when a project sets no overrides). */
export function envLlm(): LlmConfig {
  return {
    provider: env.MODERATOR_LLM_PROVIDER,
    baseUrl: env.MODERATOR_LLM_BASE_URL,
    apiKey: env.MODERATOR_LLM_API_KEY,
    model: env.MODERATOR_LLM_MODEL,
    maxTokens: env.MODERATOR_LLM_MAX_TOKENS,
  };
}

/** True when an API key is configured. When false, callers should skip assessment (no-op). */
export function moderationEnabled(cfg: LlmConfig = envLlm()): boolean {
  return !!cfg.apiKey;
}

const baseUrl = (cfg: LlmConfig) => (cfg.baseUrl ?? DEFAULT_BASE[cfg.provider]).replace(/\/+$/, "");

/**
 * Run the policy classifier over a piece of content with the given provider config (env default).
 * Throws if the LLM isn't configured or the provider returns a non-2xx / unparseable response.
 */
export async function assess(
  input: { text: string; context?: string },
  cfg: LlmConfig = envLlm(),
  categories: readonly string[] = DEFAULT_MODERATION_CATEGORIES,
): Promise<AssessResult> {
  if (!cfg.apiKey) throw new Error("LLM API key not configured");
  const system = buildSystemPrompt(categories);
  const user = buildUserPrompt(input);
  // Debug: the request shape (provider/model/host, sizes) — never the key or the content itself.
  logger.debug(
    { provider: cfg.provider, model: cfg.model, baseUrl: baseUrl(cfg), maxTokens: cfg.maxTokens, promptChars: user.length },
    "moderation: calling LLM",
  );
  const startedAt = Date.now();
  const res = cfg.provider === "anthropic" ? await callAnthropic(system, user, cfg) : await callOpenAI(system, user, cfg);
  const parsed = parseVerdict(res.text);
  logger.debug(
    {
      provider: cfg.provider, model: cfg.model, latencyMs: Date.now() - startedAt, rawChars: res.text.length,
      verdict: parsed.verdict, confidence: parsed.confidence, categories: parsed.categories,
      promptTokens: res.promptTokens, completionTokens: res.completionTokens,
    },
    "moderation: LLM responded",
  );
  return { ...parsed, model: `${cfg.provider}:${cfg.model}`, promptTokens: res.promptTokens, completionTokens: res.completionTokens };
}

const intOr0 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);

// ─── OpenAI-compatible /chat/completions ──────────────────────────────────────
async function callOpenAI(systemPrompt: string, userPrompt: string, cfg: LlmConfig): Promise<LlmResponse> {
  const res = await fetch(`${baseUrl(cfg)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      temperature: 0,
      // Ask for a JSON object. Hosts that don't support response_format ignore it; the system prompt
      // still pins the output to JSON, and parseVerdict() is tolerant.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content");
  return { text: content, promptTokens: intOr0(json.usage?.prompt_tokens), completionTokens: intOr0(json.usage?.completion_tokens) };
}

// ─── Anthropic /v1/messages ───────────────────────────────────────────────────
async function callAnthropic(systemPrompt: string, userPrompt: string, cfg: LlmConfig): Promise<LlmResponse> {
  const res = await fetch(`${baseUrl(cfg)}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey!,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = json.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("LLM returned no content");
  return { text, promptTokens: intOr0(json.usage?.input_tokens), completionTokens: intOr0(json.usage?.output_tokens) };
}

// ─── Tolerant JSON parse → normalized verdict ─────────────────────────────────
const VERDICTS: ModerationVerdict[] = ["allow", "block", "review"];

export function parseVerdict(raw: string): ParsedVerdict {
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
