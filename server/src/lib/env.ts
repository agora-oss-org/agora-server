// Centralized, validated environment access.
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  // Supabase transaction pooler — Drizzle owns DB access.
  DATABASE_URL: z.string().url(),
  // Supabase Auth + Storage only. Optional until those handlers are built, so the
  // DB-backed server boots without them. Empty strings in .env are treated as unset.
  SUPABASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  SUPABASE_ANON_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  SUPABASE_JWT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  ACCESS_TOKEN_TTL: z.coerce.number().default(1800),
  REFRESH_TOKEN_TTL: z.coerce.number().default(2592000),
  ACCESS_TOKEN_SECRET: z.string().min(1),
  REFRESH_TOKEN_GRACE_SECONDS: z.coerce.number().default(30),
  CORS_ORIGIN: z.string().default("*"),
  // The server's own public origin (scheme + host), e.g. https://api.example.com. Used to build
  // absolute callback URLs (OAuth) when the server runs behind a TLS-terminating reverse proxy,
  // where the raw request origin is the internal http://<internal-host>. When unset the server
  // falls back to X-Forwarded-Proto/Host, then the raw request origin. Set this in production.
  PUBLIC_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Shared secret gating POST /internal/cron/digests (external schedulers). Optional: when unset
  // the endpoint is disabled (503) and digests run only via scripts/send-digests.mjs.
  CRON_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Embeddings (Voyage AI). Optional until semantic search is used.
  VOYAGE_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VOYAGE_MODEL: z.string().default("voyage-3.5"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),
  // LLM (Anthropic) — powers /search/ask RAG Q&A. Optional until that endpoint is used.
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().default(1024),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
