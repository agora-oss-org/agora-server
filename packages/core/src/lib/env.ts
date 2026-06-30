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
  // Default identity backend stamped onto a NEW project at genesis (scripts/genesis.mjs). There is no
  // project-creation route, so this is how a Supabase-less deployment makes its first project use the
  // native (in-API password) auth backend instead of Supabase. Existing projects switch via admin
  // settings / SQL; getAuthProvider() reads projects.auth_provider, never this. Empty=unset→supabase.
  DEFAULT_AUTH_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["supabase", "native"]).default("supabase")),
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
  // Which DozerDB database the social graph lives in (DozerDB re-enables Neo4j multi-database on the
  // Community build). Unset → "neo4j" (the server default). The scorer (the only writer) creates it
  // on startup if missing; the API reads target it. Same value MUST be used by api + scorer.
  NEO4J_DATABASE: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Max accepted upload size (bytes) for /storage + multipart image attachments. Defense-in-depth
  // behind the proxy's body cap (the bundled Caddy edge caps at MAX_BODY_SIZE). Default 25 MiB.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400),
  // Object-storage backend for uploaded media (lib/storage.ts). `supabase` (default) → Supabase Storage
  // public bucket; `s3` → any S3-compatible store (MinIO for fully self-hosted, or real AWS S3). The
  // self-contained stack runs MinIO behind `s3`. Keys are unguessable UUID paths in a public-read bucket
  // (same posture as the Supabase public bucket — see SECURITY.md). Empty=unset→supabase.
  STORAGE_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["supabase", "s3"]).default("supabase")),
  // S3-compatible storage config — only consulted when STORAGE_PROVIDER=s3 (validated lazily in
  // lib/storage/s3.ts so a Supabase deploy never needs them). S3_ENDPOINT is the API origin
  // (e.g. http://minio:9000); S3_PUBLIC_URL is the browser-reachable base the public object URL is built
  // from (e.g. https://media.example.com or the edge's /media mount). S3_FORCE_PATH_STYLE stays true for
  // MinIO (path-style buckets); set false only for a vhost-style provider.
  S3_ENDPOINT: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  S3_BUCKET: z.string().default("agora"),
  S3_PUBLIC_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // NB: a plain z.coerce.boolean() would read the STRING "false" as true — parse the truthy/falsy
  // tokens explicitly so S3_FORCE_PATH_STYLE=false actually disables path-style.
  S3_FORCE_PATH_STYLE: z.preprocess((v) => {
    if (v === "" || v === undefined) return true;
    if (typeof v === "string") return !["false", "0", "no", "off"].includes(v.toLowerCase());
    return v;
  }, z.boolean()),
  // Web push (VAPID) — optional until push notifications are enabled. The public key is published to clients;
  // the private key and subject are used to sign the server's VAPID JWT with push service subscriptions.
  VAPID_PUBLIC_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VAPID_PRIVATE_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VAPID_SUBJECT: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()), // mailto: or https URL
  // Secure-chat (E2E) ciphertext caps, enforced on the DECODED byte length. Deliberately NOT the
  // 25 MiB upload cap — that would invite DoS. App messages are small (default 256 KiB); MLS
  // handshakes (Welcome/Commit) scale with group size so they get a larger, separate cap (4 MiB).
  MAX_SECURE_MESSAGE_BYTES: z.coerce.number().int().positive().default(262_144),
  MAX_SECURE_HANDSHAKE_BYTES: z.coerce.number().int().positive().default(4_194_304),
  // IUC restore-blob courier (ENVELOPE history restore) — an ephemeral, targeted, opaque drop-box.
  // The per-blob byte cap is CHUNK granularity, not a ceiling on total restorable history (a large
  // history is N independent blobs reassembled client-side). TTL is the sweep backstop for a blob the
  // recipient never explicitly DELETEs. Quotas bound outstanding (unexpired) blobs per (uploader→target)
  // pair and per target device. See apps/secure-chat/docs/RESTORE.md.
  MAX_SECURE_RESTORE_BLOB_BYTES: z.coerce.number().int().positive().default(16_777_216), // 16 MiB
  SECURE_RESTORE_BLOB_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
  MAX_SECURE_RESTORE_BLOBS_PER_PAIR: z.coerce.number().int().positive().default(16),
  MAX_SECURE_RESTORE_BLOBS_PER_TARGET: z.coerce.number().int().positive().default(64),
  // Embeddings (Voyage AI). Optional until semantic search is used.
  VOYAGE_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VOYAGE_MODEL: z.string().default("voyage-3.5"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),
  // Outbound abuse throttle on Voyage embedding calls (lib/embed-throttle.ts). A per-project, in-process
  // circuit breaker with hysteresis: when a project's embed rate (req/sec, averaged over the window)
  // crosses *_SPIKE_RATE it trips and stops embedding for that project until the rate falls to
  // *_RESUME_RATE and stays there for *_RESUME_MS. Write-path embeds skipped while tripped are persisted
  // to pending_embeddings (drained by /internal/cron/drain-embeddings); search-path embeds return 429.
  // Each stream is OFF until its *_SPIKE_RATE is set (mirrors RATE_LIMIT_MAX). When unset, RATE_MAX (the
  // elevated/warn line) and RESUME_RATE (the normal level) default to fractions of SPIKE_RATE, so only
  // SPIKE_RATE is required to enable a stream.
  EMBED_THROTTLE_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  EMBED_THROTTLE_WRITE_SPIKE_RATE: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().positive().optional()),
  EMBED_THROTTLE_WRITE_RATE_MAX: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().positive().optional()),
  EMBED_THROTTLE_WRITE_RESUME_RATE: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().positive().optional()),
  EMBED_THROTTLE_WRITE_RESUME_MS: z.coerce.number().int().positive().default(30_000),
  EMBED_THROTTLE_SEARCH_SPIKE_RATE: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().positive().optional()),
  EMBED_THROTTLE_SEARCH_RATE_MAX: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().positive().optional()),
  EMBED_THROTTLE_SEARCH_RESUME_RATE: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().positive().optional()),
  EMBED_THROTTLE_SEARCH_RESUME_MS: z.coerce.number().int().positive().default(30_000),
  // Safety valve: cap rows held in pending_embeddings (per the throttle). Beyond it, enqueue skips +
  // warns so a runaway can't blow up that table too. Unset = unbounded (drain cron is the relief).
  EMBED_THROTTLE_MAX_PENDING: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  // LLM (Anthropic) — powers /search/ask RAG Q&A. Optional until that endpoint is used.
  ANTHROPIC_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().default(1024),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
