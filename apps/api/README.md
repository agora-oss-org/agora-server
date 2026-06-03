# @agora/api

> The Agora backend — a Replyke-API-compatible community/social server.

Hono on Node 22, one router per domain under `/v7/:projectId/*`, talking to Supabase Postgres
through Drizzle. This is the **reference package**: the contract's server side, and where every
endpoint, permission check, and piece of business logic lives.

For the project overview, see the [root README](../../README.md). For the exact wire contract, see
[`docs/MANIFEST.md`](../../docs/MANIFEST.md) (endpoints + socket.io events) and
[`docs/MODELS.md`](../../docs/MODELS.md) (response shapes).

## Stack

- **API** — [Hono](https://hono.dev) on Node 22, one router per domain under `/v7/:projectId/*`
- **Data** — **Drizzle ORM** over a direct `postgres.js` connection to the Supabase transaction
  pooler (`:6543`, `prepare:false`). Drizzle owns *all* DB access; the schema in
  `src/db/schema/*.ts` is the single source of truth.
- **Auth** — Supabase Auth backs password identity + confirmation/reset emails; Agora mints its own
  access (30 m) + refresh (30 d) tokens with **rotation + reuse-detection + 30 s grace**. External
  users authenticate via RS256 JWT (verified against a per-project public key). OAuth providers are
  brokered through Supabase (PKCE).
- **Realtime** — **socket.io** for chat; REST writes fan out durable events to conversation rooms,
  byte-compatible with the SDK's socket contract.
- **Search** — **Voyage AI** (`voyage-3.5`) embeddings + pgvector for semantic content search;
  **Anthropic** powers `/search/ask` RAG Q&A (streamed over SSE).
- **Storage** — Supabase Storage; images get `sharp`-generated webp variants.
- **Webhooks** — Replyke-style project webhooks (blocking validation + fire-and-forget broadcast,
  HMAC-signed) plus per-space content digests.
- **Supabase JS client** — reserved for Auth + Storage *only*; everything else is Drizzle.

## Architecture

```
client + forked Replyke SDK
   │  HTTPS  /v7/:projectId/<domain>/...        (+ socket.io for chat realtime)
   ▼
@agora/api  (Hono)   endpoints · business logic · permission checks
   │  Drizzle ORM (postgres.js, Supabase transaction pooler :6543, prepare:false)   ← owner role, bypasses RLS
   ▼
Supabase Postgres   schema · triggers · RPC · pgvector · PostGIS · RLS
        ├── Supabase Auth     (passwords, confirmation/reset emails, OAuth)
        └── Supabase Storage  (file/image bytes)
        Voyage AI ──▶ embeddings        Anthropic ──▶ /search/ask answers
```

**The server is the trust boundary.** It connects as the table-owner role (so RLS never constrains
it) and enforces every ownership / role check in the handlers. RLS is enabled as defense-in-depth
with public-read policies — a client *could* read public content directly with the publishable key —
but in normal operation everything flows through the Agora API.

## Layout

```
apps/api/
├── drizzle/     # generated + hand-written SQL migrations (0000–0019)
├── scripts/     # seed.sql, send-digests.mjs, recompute-scores.mjs, *-e2e.mjs
├── test/        # vitest integration suites (real cloud Postgres)
└── src/
    ├── index.ts     # entrypoint: serves the app + attaches socket.io
    ├── app.ts       # createApp() — side-effect-free Hono app (drives in-process tests)
    ├── db/          # Drizzle client + schema/*.ts (source of truth)
    ├── lib/         # env, supabase, tokens, embeddings, llm, storage, shape, validation, webhooks,
    │                #   digests, ranking, feed-config, recompute, rerank, space-access,
    │                #   moderation-config, moderation-visibility
    ├── http/        # error + pagination envelopes, context types
    ├── middleware/  # project resolution, JWT auth
    ├── routes/      # one router per domain
    └── realtime/    # socket.io server, typed to the SDK's event contract
```

`src/routes/entities.ts` is the reference for a fully-built domain router.

## Getting started

From the **repo root** (the api depends on the built `@agora/contract` package):

```bash
corepack enable          # activate the pinned pnpm
pnpm install             # install all workspaces
pnpm -r build            # build every package (contract first, topologically)
```

Then, from `apps/api`:

```bash
cp .env.example .env      # fill in DATABASE_URL (required) — see Configuration below
pnpm db:migrate           # apply migrations to your Supabase DB (idempotent; safe to re-run)
pnpm dev                  # http://localhost:4000/v7   (GET /health to verify)

# optional: seed dev data + validate triggers/RPC (asserts loudly on failure)
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seeds/seed.sql
```

## Commands

Run from `apps/api`, or `pnpm --filter @agora/api <script>` from the repo root:

```bash
pnpm dev                  # tsx watch -> http://localhost:4000/v7  (loads .env via dotenv)
pnpm typecheck            # tsc --noEmit  — run before considering work done
pnpm build                # tsc -> dist/
pnpm db:generate          # after editing src/db/schema/*.ts -> a new migration in drizzle/
pnpm db:migrate           # apply migrations (idempotent: journal skips applied; safe to re-run)
pnpm test                 # unit tests (no DB)
pnpm test:integration     # integration tests (needs TEST_DATABASE_URL — a dedicated cloud DB)
```

## Configuration (`.env`)

The repo's root `.env` is the single source (symlinked to `apps/api/.env`). Only `DATABASE_URL` is
strictly required; the rest gate specific features and are validated as optional (empty strings are
treated as unset).

```ini
# Database — Supabase transaction pooler (:6543). The only hard requirement.
DATABASE_URL=postgresql://postgres.<ref>:<pw>@<region>.pooler.supabase.com:6543/postgres

# Supabase Auth + Storage (enables password auth, OAuth, uploads)
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...        # admin auth ops
SUPABASE_ANON_KEY=sb_publishable_...           # user auth (signUp / signIn / reset)

# Agora-issued tokens
ACCESS_TOKEN_SECRET=<random>                   # required — signs Agora access tokens
ACCESS_TOKEN_TTL=1800                          # 30 m
REFRESH_TOKEN_TTL=2592000                      # 30 d
REFRESH_TOKEN_GRACE_SECONDS=30                 # racing-tabs reuse grace window

CORS_ORIGIN=*
PUBLIC_BASE_URL=https://api.example.com        # this server's public origin; set behind a proxy (see OAuth below)

# Operators (deployment-wide admin god-view; comma-separated)
OPERATOR_USER_IDS=                             # profile UUIDs
OPERATOR_EMAILS=                               # case-insensitive emails

# Observability (wonder-logger; configured in wonder-logger.yaml)
LOG_LEVEL=info                                 # trace|debug|info|warn|error|fatal|silent
LOG_CONSOLE=aligned                            # aligned (dev, colorized) | json (prod; the Docker image sets json)
SERVICE_NAME=agora-api                         # service label in logs/traces/metrics
# OpenTelemetry (traces + metrics + OTLP log export). Point these at your collector; metrics also on :9464.
OTEL_TRACES_ENDPOINT=http://localhost:4318/v1/traces
OTEL_METRICS_ENDPOINT=http://localhost:4318/v1/metrics
OTEL_LOGS_ENDPOINT=http://localhost:4318/v1/logs
# OTEL_SDK_DISABLED=true                        # turn OpenTelemetry off entirely (no collector needed)
CRON_SECRET=                                   # gates the POST /internal/cron/* triggers (digests, recompute, token purge)

# Edge rate limiting (optional; off unless a max is set). Behind a proxy — client IP from X-Forwarded-For.
RATE_LIMIT_WINDOW_SECONDS=60                    # window length
RATE_LIMIT_MAX=                                # general per-IP cap per window (unset = no general limit)
RATE_LIMIT_AUTH_MAX=                           # stricter cap for /auth/* (unset = falls back to RATE_LIMIT_MAX)

# Semantic search — Voyage AI (optional)
VOYAGE_API_KEY=pa-...
VOYAGE_MODEL=voyage-3.5
EMBEDDING_DIMENSIONS=1024

# RAG /search/ask — Anthropic (optional)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_MAX_TOKENS=64000

# Automated moderation (the @agora/moderator service; optional). Gates POST /internal/moderation/apply,
# which the moderator calls to write back removals. See apps/moderator/README.md.
MODERATION_SERVICE_SECRET=<random>             # shared secret for the moderator's write-back
```

### OAuth providers (Supabase Redirect URLs)

OAuth (GitHub, Google, …) is brokered through Supabase with PKCE. The server starts the flow by
asking Supabase to redirect back to **its own** callback —
`<public-origin>/v7/<projectId>/oauth/callback?aid=<state>` (`routes/misc.ts`, `startOAuth`). After
exchanging the code it mints Agora tokens and redirects the browser to the app's `redirectAfterAuth`
with `#accessToken=…&refreshToken=…` in the fragment.

**Behind a reverse proxy, set `PUBLIC_BASE_URL`.** The callback's `<public-origin>` is resolved as
`PUBLIC_BASE_URL` → else `X-Forwarded-Proto`/`X-Forwarded-Host` → else the raw request origin. With
TLS terminated at the proxy, the raw request origin is the internal `http://<internal-host>` (wrong
scheme *and* host), which won't match the allowlist and silently falls back to the Site URL. Set
`PUBLIC_BASE_URL=https://api.example.com` (the host clients reach) for a deterministic callback.

For the first hop to succeed, **Supabase → Authentication → URL Configuration → Redirect URLs**
must allow the **server's** callback — *not* the front-end app's origin:

```
https://<your-server-host>/v7/*/oauth/callback**
http://localhost:4000/v7/*/oauth/callback**
```

- Use the **API/server** host (where this server is deployed), not the SPA/demo host. The
  `redirect_to` is built from the server origin.
- `*` matches the project-id segment (Supabase treats only `.` and `/` as separators, so the UUID is
  covered). A trailing `**` is **required** — Supabase matches the *full* `redirect_to` including
  the `?aid=<state>` query the server appends, and a bare `…/oauth/callback` will not match (it
  silently falls back to your **Site URL** with `?code=…`, so the login dead-ends).
- The provider's own callback in its developer console (and the Supabase provider's "Callback URL")
  stays `https://<ref>.supabase.co/auth/v1/callback` — that's unrelated to this allowlist.

## Database

The schema lives in `src/db/schema/*.ts` and is the single source of truth. `drizzle-kit generate`
emits table DDL; anything Drizzle can't express (triggers, RPC, RLS, PostGIS) is a hand-written
custom migration, applied in journal order and written **idempotently** so re-runs are safe.
Migrations `0000`–`0019` cover extensions + enums + tables, PostGIS columns/indexes, denormalization
triggers, RPC functions (`toggle_reaction`, `hot_score`, `fetch_comment_thread`, `match_content`,
`space_readable`, …), RLS (deny-all backstop + public-read + authenticated self-access), refresh
tokens, project webhooks, OAuth state, content embeddings, feed + moderation config, and the
score-recompute function.

To change the schema: edit `src/db/schema/*.ts` → `pnpm db:generate` → `pnpm db:migrate`. Edit
triggers/functions/RLS/PostGIS by hand in their custom migration files.

## Handler conventions

These keep the contract intact — don't break them:

- **URL shape is fixed:** `/v7/:projectId/<domain>/...`. In a domain router, static routes
  (`/by-username`, `/root`, …) MUST be declared **above** `/:id` or Hono captures them.
- **Envelopes are contract.** Lists → `{ data, pagination }` via `paginate()`/`readPagination()`.
  Errors → throw `Errors.*` (→ `{ error, code, field? }`), never bare strings.
- **Shape every row** through `lib/shape.ts` — camelCase, Date→ISO, derive `userReaction`/`isSaved`,
  blank deleted comments. Don't return raw Drizzle rows.
- **Denormalized counts are trigger-maintained** — never recompute per request.
- **Ownership/role checks live in handlers.** The trust boundary is the server, not RLS.
- **Moderation visibility** — any new read path over moderatable content must apply `removedPolicy(c)`.
- **Logging:** use the shared `logger` (`lib/logger.ts`, Pino), never `console.*`. Pino arg order is
  data-object-FIRST: `logger.error({ err }, "msg")`.

## Testing

[Vitest](https://vitest.dev), two tiers:

- **Unit** (`src/**/*.test.ts`) — pure logic (shapers, validation, envelopes, HMAC), no DB.
- **Integration** (`test/integration/**`) — runs against a real dedicated cloud Postgres via
  `TEST_DATABASE_URL`, driving the app in-process with `app.request()` (plus a booted socket.io
  server for the chat realtime suites). Isolation is by `project_id`: each test mints its own
  project + users and cascade-cleans on teardown.

```bash
pnpm test                 # unit
pnpm test:integration     # integration (set TEST_DATABASE_URL first)
```

## Webhooks & digests

- **Project webhooks** (`lib/webhooks.ts`) — Replyke-style. Validation events (e.g.
  `entity.created`) are synchronous + blocking and HMAC-signed; the host replies with a signed
  `{ valid }` to allow or veto. `*.complete` events are fire-and-forget broadcasts. Configure via
  the project-admin endpoints; once configured, an unavailable receiver fails closed.
- **Space digests** (`lib/digests.ts`) — opt-in per space; an HMAC-signed `space.digest` of recent
  entities is POSTed to the space's own webhook on its scheduled hour. The trigger is decoupled from
  the work: run `scripts/send-digests.mjs` standalone (cron / launchd), or have an external scheduler
  (e.g. Supabase `pg_cron` + `pg_net`) hit the secret-gated `POST /internal/cron/digests`.

## Feed ranking

The feed is **pluggable and tunable** without putting any host code (or arbitrary SQL) in the
database. Ranking lives in a closed registry (`lib/ranking.ts`); algorithm names are a fixed enum and
every tunable is a validated, range-clamped *number*.

**Algorithms** (`GET /entities?sortBy=…`):

| `sortBy` | Ranks by | Storage |
|---|---|---|
| `hot` | time-anchored Reddit score (`hot_score`, denormalized `entities.score`) — recency + votes | stored, index-served, refreshed on vote |
| `top` | pure weighted-net votes, no time term (pair with `timeFrame` for "top this week") | live |
| `new` | recency | live |
| `controversial` | balanced disagreement (`least(up,down)`, then volume) | live |
| `decay` | **true exponential half-life** — `quality · 0.5^(age/halfLife)` | live (or stored via cron) |
| `gravity` | Hacker News — `(net−1)/(ageₕ+2)^G` | live |
| `wilson` | Wilson lower-bound confidence on up/(up+down) | live |
| `bayesian` | shrunk mean `(C·m+up)/(C+up+down)` | live |

**Layered configuration** (precedence: request → project → built-in defaults):

- **Per request** — `sortBy` plus optional `rankParams` (JSON scalar of numeric tunables, e.g.
  `?rankParams={"halfLifeHours":12}`), `rankAnchor` (pins the decay clock across paginated requests;
  the server echoes the resolved anchor back), and `rerank=true`.
- **Per project** — `projects.feed_config` jsonb (`lib/feed-config.ts`, 30s-cached), set via
  project-admin **`GET`/`PATCH /settings/feed`**:
  `{ defaultAlgorithm, decayMode, halfLifeHours, gravity, reactionWeights, diversity, rerankWebhook }`.

**Two decay models coexist.** `hot`/`top` use the stored, index-served score. True `decay` defaults
to **query-time** (accurate against `now()`); set `decayMode:"stored"` to have the cron snapshot the
evaluated half-life into `entities.score` (index-served, minutes-stale). The recompute job
(`recompute_decay_scores`/`recompute_scores`, orchestrated by `lib/recompute.ts`) runs standalone via
`scripts/recompute-scores.mjs` or the secret-gated `POST /internal/cron/recompute-scores`.

**Re-rank webhook (escape hatch).** With `feed_config.rerankWebhook` set and `?rerank=true`, the
server over-fetches a candidate pool, POSTs it HMAC-signed to the host app, and applies the returned
ordering — **fail-open** to the algorithm order on timeout/error (`lib/rerank.ts`).

## Docker

The api ships a multi-stage `Dockerfile` (`node:22-slim`; **built from the repo root** since it
depends on the `@agora/contract` workspace package — `pnpm deploy` bundles a prod-only standalone,
run as a non-root user with a `/health` healthcheck). Postgres/Auth/Storage are on Supabase, so
there's no local DB to run — the container just needs your `.env`.

```bash
# build context = repo root
docker build -f apps/api/Dockerfile -t agora-api .
docker run  --rm --init --env-file .env -p 4000:4000 agora-api

# apply migrations as a one-off task (drizzle-kit-free, runtime deps only)
docker run  --rm --env-file .env agora-api node scripts/migrate.mjs
```

Migrations are applied via `scripts/migrate.mjs` (uses only runtime deps), so they run as a
**separate one-off task or init step rather than on container boot** — scaling to multiple replicas
won't race migrations against each other. See the [root README](../../README.md#docker) for the full
`docker compose` stack (api + admin + moderator).

## License

[Apache-2.0](../../LICENSE) — matching Replyke.
