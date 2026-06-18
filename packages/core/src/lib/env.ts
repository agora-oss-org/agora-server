// Centralized, validated environment access.
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  // The @agora/secure-chat process listens here (it's a SEPARATE deployable from @agora/api). The api
  // ignores this; secure-chat ignores PORT. Both share this one validated schema (kernel @agora/core).
  SECURE_CHAT_PORT: z.coerce.number().default(4002),
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
  // HS256 signing key for access JWTs — must be high-entropy. Generate: `openssl rand -base64 48`.
  ACCESS_TOKEN_SECRET: z.string().min(32, "ACCESS_TOKEN_SECRET must be at least 32 characters (use `openssl rand -base64 48`)"),
  REFRESH_TOKEN_GRACE_SECONDS: z.coerce.number().default(30),
  CORS_ORIGIN: z.string().default("*"),
  // Deployment-operator allowlist for the admin app. Comma-separated profile UUIDs and/or emails;
  // a signed-in identity matching either set is stamped `isOperator` (project-wide god-view in the
  // admin: all spaces/content/reports). Unset → no operators (everyone is space-scoped). Empty=unset.
  OPERATOR_USER_IDS: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  OPERATOR_EMAILS: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // The server's own public origin (scheme + host), e.g. https://api.example.com. Used to build
  // absolute callback URLs (OAuth) when the server runs behind a TLS-terminating reverse proxy,
  // where the raw request origin is the internal http://<internal-host>. When unset the server
  // falls back to X-Forwarded-Proto/Host, then the raw request origin. Set this in production.
  PUBLIC_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Shared secret gating the POST /internal/cron/* triggers (digests, score recompute, token purge)
  // for external schedulers. Optional: when unset those endpoints are disabled (503) and the work
  // runs only via the standalone scripts/*.mjs.
  CRON_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Shared secret gating POST /internal/moderation/apply — the write-back the services/scorer
  // service calls to apply an automated decision (moderationStatus, moderatedByType="client").
  // Optional: when unset the endpoint is disabled (503) and no service can auto-moderate.
  MODERATION_SERVICE_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Edge rate limiting (fixed window; see middleware/rate-limit.ts). OFF unless a max is set.
  // RATE_LIMIT_MAX caps general per-IP traffic per window; RATE_LIMIT_AUTH_MAX is a stricter cap for
  // /auth/* (brute-force target), falling back to the general cap when unset.
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  RATE_LIMIT_AUTH_MAX: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  // Number of TRUSTED reverse proxies in front of the app. The client IP is read this many hops from
  // the RIGHT of X-Forwarded-For (the entries trusted proxies actually wrote), so a client can't spoof
  // it via a left-most value. Your edge must overwrite X-Forwarded-For with the real peer (1 = a single
  // nginx/CDN edge). Falls back to X-Real-IP when XFF has fewer hops than this.
  RATE_LIMIT_TRUSTED_HOPS: z.coerce.number().int().positive().default(1),
  // OPTIONAL shared store for cross-replica rate limiting. When set, the limiter counts in Redis so the
  // cap holds across API replicas; unset → in-process (per-replica) limiting. The app fail-opens to
  // in-memory if Redis is unreachable. A single replica needs no Redis. e.g. redis://redis:6379
  REDIS_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Neo4j (DozerDB) — the social graph's READ side (docs/SOCIAL-GRAPH.md §3). The scorer service is
  // the graph's only writer; the API only runs read queries (Weather). Unset → social graph read
  // endpoints return 503 and the rest of the server is unaffected. e.g. bolt://neo4j:7687
  NEO4J_URI: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  NEO4J_AUTH: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Max accepted upload size (bytes) for /storage + multipart image attachments. Defense-in-depth
  // behind the proxy's body cap (the bundled Caddy edge caps at MAX_BODY_SIZE). Default 25 MiB.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400),
  // Secure-chat (E2E) ciphertext caps, enforced on the DECODED byte length. Deliberately NOT the
  // 25 MiB upload cap — that would invite DoS. App messages are small (default 256 KiB); MLS
  // handshakes (Welcome/Commit) scale with group size so they get a larger, separate cap (4 MiB).
  MAX_SECURE_MESSAGE_BYTES: z.coerce.number().int().positive().default(262_144),
  MAX_SECURE_HANDSHAKE_BYTES: z.coerce.number().int().positive().default(4_194_304),
  // Embeddings (Voyage AI). Optional until semantic search is used.
  VOYAGE_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VOYAGE_MODEL: z.string().default("voyage-3.5"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),
  // LLM (Anthropic) — powers /search/ask RAG Q&A. Optional until that endpoint is used.
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().default(1024),
  // Umami analytics — report discrete usage events (signups/posts/comments/…). Optional; no-op when unset.
  // SERVER_ID = the product-events website; ADMIN_ID = the admin app's website (reporting proxy reads
  // both back via the API_KEY for the operator Analytics page). SERVER_HOSTNAME tags server-side sends;
  // ADMIN_HOSTNAME is informational only — the browser tracker auto-reports window.location.hostname.
  AGORA_UMAMI_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  AGORA_UMAMI_SERVER_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AGORA_UMAMI_ADMIN_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AGORA_UMAMI_SERVER_HOSTNAME: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AGORA_UMAMI_ADMIN_HOSTNAME: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AGORA_UMAMI_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Reporting-API auth. `x-umami-api-key` (above) works on Umami **Cloud** only; **self-hosted**
  // (cloudMode:false) authenticates via POST /api/auth/login → Bearer token, so set these instead.
  // When both are present they take precedence over the API key.
  AGORA_UMAMI_USERNAME: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AGORA_UMAMI_PASSWORD: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Collect endpoint for server-side sends, relative to AGORA_UMAMI_URL. Default is stock Umami's
  // `/api/send`; a deployment can remap it (e.g. `/v7/send` to dodge ad-blockers) and set this to match.
  AGORA_UMAMI_SEND_PATH: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("/api/send")),
  // Base for the Umami *reporting* API (`/api/websites/...`) when it isn't reachable on AGORA_UMAMI_URL
  // (e.g. the public host only exposes the tracker + collect routes; the dashboard API is its own host).
  // Falls back to AGORA_UMAMI_URL when unset.
  AGORA_UMAMI_API_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
