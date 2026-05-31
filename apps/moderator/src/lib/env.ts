// Centralized, validated environment access for @agora/moderator.
// Empty strings in .env are treated as unset (matching @agora/api), so optional feature keys can be
// present-but-blank in a shared root .env without accidentally enabling a half-configured provider.
import { z } from "zod";

const optionalStr = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const schema = z.object({
  // The moderator listens on its own port (4001 by default) alongside the API (4000).
  PORT: z.coerce.number().default(4001),
  // Same Supabase transaction pooler as the API — the moderator READS projects.webhook_secret and
  // READS/WRITES its own moderation_analyses table. DDL is owned by the API's Drizzle migrations.
  DATABASE_URL: z.string().url(),
  // Shared with the API: verifies the operator JWT the admin app already holds (HS256). Required so
  // the admin-facing /moderation/* endpoints can be authenticated.
  ACCESS_TOKEN_SECRET: z.string().min(1),
  CORS_ORIGIN: z.string().default("*"),

  // The API's ORIGIN (no /v7), e.g. http://localhost:4000. The moderator POSTs the write-back to
  // {API_BASE_URL}/internal/moderation/apply (an app-root internal endpoint, like /internal/cron/*).
  API_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Shared secret gating the API's POST /internal/moderation/apply. Must match the API's
  // MODERATION_SERVICE_SECRET. When unset, auto-action write-backs are disabled (verdicts still
  // persist + queue for humans).
  MODERATION_SERVICE_SECRET: optionalStr,
  // Auto-act when verdict==="block" AND confidence >= this threshold (0..1). 0 (or unset) disables
  // automatic removal entirely — everything routes to the human AI-flag queue.
  MODERATION_AUTO_ACTION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  // ─── Generic LLM provider ────────────────────────────────────────────────
  // "openai"   → OpenAI-compatible /chat/completions (OpenAI, Groq, Together, OpenRouter, Ollama,
  //              vLLM, LM Studio … anything speaking the OpenAI shape; pick the host via BASE_URL).
  // "anthropic"→ Anthropic /v1/messages.
  MODERATOR_LLM_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
  // Provider HTTP base (no trailing slash). Defaults are filled per-provider in llm-provider.ts when
  // unset, so a plain OpenAI/Anthropic key works with no extra config.
  MODERATOR_LLM_BASE_URL: optionalStr,
  MODERATOR_LLM_API_KEY: optionalStr,
  MODERATOR_LLM_MODEL: z.string().default("gpt-4o-mini"),
  MODERATOR_LLM_MAX_TOKENS: z.coerce.number().default(512),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
