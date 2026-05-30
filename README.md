<p align="center">
  <img src="assets/agora.png" alt="Agora logo" width="200" height="200" />
</p>

<h1 align="center">Agora</h1>

<p align="center"><em>The open social layer. Own your community.</em></p>

<p align="center">
  <a href="https://demo.agora-oss.org"><img src="https://img.shields.io/badge/▶_live_demo-demo.agora--oss.org-7C3AED.svg" alt="Live demo" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <a href="https://supabase.com"><img src="https://img.shields.io/badge/built%20on-Supabase-3ECF8E.svg" alt="Built on Supabase" /></a>
  <a href="#status"><img src="https://img.shields.io/badge/backend-feature--complete-success.svg" alt="Status: feature-complete" /></a>
</p>

<p align="center">
  ▶️ <strong>Try it live: <a href="https://demo.agora-oss.org">demo.agora-oss.org</a></strong>
</p>

A working social app — sign in, browse the feed, comment, react, semantic-search, and chat in
realtime — all driven by the [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) against a live
Agora backend.

**Agora is an open-source, self-hosted, 1:1-compatible replacement for the [Replyke](https://github.com/replyke/monorepo) backend, built on Supabase.**

Replyke is a hosted backend for community & social features. Agora reimplements that backend so the
[`agora-sdk`](https://github.com/jenova-marie/agora-sdk) (a repointed fork of the Replyke SDK) talks
to **your** server instead of `api.replyke.com` — byte-for-byte the same REST paths, response shapes,
auth semantics, and socket.io events. You keep Replyke's
opinionated feature set (posts, threaded comments, reactions & feeds, follows & connections, nested
spaces, real-time chat, notifications, moderation, semantic search) and run it all on infrastructure
you control, under a permissive license.

Apache-2.0, like Replyke. No vendor lock-in, no per-seat pricing, no data leaving your project.

## Why

Supabase hands you ~40% of a social backend for free: Postgres, Auth (GoTrue), Storage, Realtime
infrastructure, and pgvector. The other ~60% — the social schema, the denormalized counts, the
permission model, and the opinionated endpoints that sit in front of all of it — is what makes
Replyke worth using. **That 60% is what Agora builds**, and it's the part you'd otherwise rent.

## The contract is the constraint

Agora's whole reason to exist is that the forked SDK's typed hooks work **unchanged**. So the
contract is non-negotiable and fully specified:

- **[`docs/MANIFEST.md`](docs/MANIFEST.md)** — every REST endpoint (method + path, marked
  ✅ SDK-confirmed vs 🔶 inferred), the socket.io event names, and the auth / pagination / error
  envelopes. This is the checklist.
- **[`docs/MODELS.md`](docs/MODELS.md)** — field-level response shapes; the source of truth for both
  API output and the database schema.

Match these exactly or the SDK's hooks break — that discipline is what makes the "1:1" claim real.

## Stack

- **API** — [Hono](https://hono.dev) on Node 22, one router per domain under `/v7/:projectId/*`
- **Data** — **Drizzle ORM** over a direct `postgres.js` connection to the Supabase transaction
  pooler (`:6543`, `prepare:false`). Drizzle owns *all* DB access; the schema in
  `server/src/db/schema/*.ts` is the single source of truth.
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

## Security & access control

The trust boundary is the server: it talks to Postgres as the RLS-bypassing owner role and enforces
every read/write rule in the handlers, with RLS underneath as a verified backstop.

- **Tokens.** Agora mints its own short-lived access tokens (30 m) + refresh tokens (30 d) with
  **rotation, reuse-detection, and a 30 s racing-tabs grace window** — replaying a spent refresh
  token revokes the whole token family. Identity is backed by Supabase Auth (passwords / OAuth) or an
  external RS256 JWT verified against a per-project public key.
- **Anonymous reads, authenticated writes.** Public content (feed, entities, comments, search) is
  readable **without a token** — matching Replyke's contract so the SDK's hooks work for logged-out
  visitors. Every mutation (`POST`/`PATCH`/`DELETE`, reactions, reports, chat) is `requireAuth`.
- **Space privacy** (`lib/space-access.ts`). A members-only space (`readingPermission: "members"`)
  is invisible to non-members on **every** path — excluded from the feed, `403` on single
  entity/comment reads, on reactions, and on comment creation, and filtered out of semantic search.
  Creation obeys `postingPermission` (`anyone` / `members` / `admins`) via `assertCanPostInSpace`.
- **Private chat.** Conversation messages are readable only by **active members** — enforced on the
  chat REST routes (`requireMember`) and *inside* the `match_content` search RPC, so private DM /
  group / space-channel content can't surface via embeddings.
- **Moderation visibility** (`lib/moderation-config.ts` / `-visibility.ts`). Content moderated as
  "removed" is enforced on reads, configurable per project (admin **Settings → Moderation**):
  **hide** (filtered out / `404`) or **placeholder** (a blanked "[removed]" stub that preserves reply
  chains). Moderators and operators still see it for review.
- **Operators.** A deployment-operator allowlist (`OPERATOR_USER_IDS` / `OPERATOR_EMAILS`) grants a
  project-wide moderation/admin god-view, carried as an `operator` JWT claim (no per-request DB hit).
- **RLS backstop.** RLS denies `anon`/`authenticated` any private-space, removed, or draft row
  directly (migrations `0008`/`0017`) — defense-in-depth that holds even if a handler regresses.
- **Plus.** HMAC-signed webhooks, SSRF-guarded link-preview fetches, optional edge rate limiting
  (stricter on `/auth/*`), and a refresh-token cleanup sweep.

## Features

Every domain below is implemented and validated against live cloud Supabase. The **REST surface is
complete** — no stubbed endpoints remain.

| Domain | Highlights |
|---|---|
| **entities** | feed with full filter grammar + **pluggable ranking** (`hot`/`top`/`new`/`controversial`/`decay`/`gravity`/`wilson`/`bayesian`, per-project + per-request tunable — see [Feed ranking](#feed-ranking)), CRUD, drafts, foreign/short-id lookup, reactions, saved state |
| **comments** | threaded (adjacency list + recursive CTE full-tree endpoint), reactions, Reddit-style soft delete, `sortBy` |
| **users / follows** | profiles, follow graph + counts, suggestions |
| **connections** | bidirectional friend-request state machine (none → pending → connected/declined) with directional status |
| **spaces** | nested spaces (depth cap + cycle guard), membership (join/approve/ban/roles), rules, moderation queues, **digest config** |
| **collections** | nestable saved-entity folders |
| **notifications** | fan-out across every write path, inbox, unread count, mark read |
| **reports** | report queue + resolution (entities, comments, chat messages) |
| **auth** | sign-up/in/out, refresh rotation + reuse-detection, change/reset password, email verify, external RS256, OAuth provider sign-in/link |
| **chat** | conversations (direct/group/space), members, messages, reactions, typing, read state — **socket.io realtime** |
| **search** | semantic content search across entities/comments/messages (Voyage + pgvector), RAG `/ask` (Anthropic, SSE), text search for spaces/users |
| **storage** | file uploads + image variants (sharp → webp, 5 sizing modes) |
| **webhooks** | project webhooks (HMAC validation gates + `*.complete` broadcasts) + per-space digests |
| **misc** | oauth identities, lean project info, link/OG metadata (SSRF-guarded), external-JWT signing |

Denormalized counts (reaction counts, reply counts, member counts, thread counts, reputation) are
maintained atomically by Postgres **triggers** — never recomputed per request.

## Layout

pnpm workspaces — `apps/*` + `packages/*`:

```
agora/
├── LICENSE              # Apache-2.0
├── package.json         # workspace root (pnpm@10.14.0 via corepack)
├── pnpm-workspace.yaml  # apps/*, packages/*
├── tsconfig.base.json   # shared compiler options
├── docker-compose.yml   # api + supercronic cron sidecar (builds from the repo root)
├── docs/
│   ├── MANIFEST.md      # the exact REST + socket.io contract (SDK-confirmed vs inferred)
│   └── MODELS.md        # field-level response shapes (drive both the API and the schema)
├── db/README.md         # database overview (schema lives in apps/api/src/db/schema)
├── packages/
│   └── contract/        # @agora/contract — shared API types + zod schemas (no hono/drizzle)
└── apps/
    ├── admin/           # @agora/admin — Vite + React + TS admin frontend (consumes @agora/contract)
    └── api/             # @agora/api — the backend
        ├── drizzle/     # generated + hand-written SQL migrations (0000–0019)
        ├── scripts/     # seed.sql, send-digests.mjs, recompute-scores.mjs, *-e2e.mjs
        ├── test/        # vitest integration suites (real cloud Postgres)
        └── src/
            ├── index.ts     # entrypoint: serves the app + attaches socket.io
            ├── app.ts       # createApp() — side-effect-free Hono app (drives in-process tests)
            ├── db/          # Drizzle client + schema/*.ts (source of truth)
            ├── lib/         # env, supabase, tokens, embeddings, llm, storage, shape, validation, webhooks, digests, ranking, feed-config, recompute, rerank, space-access, moderation-config, moderation-visibility
            ├── http/        # error + pagination envelopes, context types
            ├── middleware/  # project resolution, JWT auth
            ├── routes/      # one router per domain
            └── realtime/    # socket.io server, typed to the SDK's event contract
```

This repository is the backend. The client SDK lives in a companion repository,
[`jenova-marie/agora-sdk`](https://github.com/jenova-marie/agora-sdk) (see **Client SDK** below).

## Getting started

```bash
corepack enable          # activate the pinned pnpm
pnpm install             # install all workspaces (from the repo root)
pnpm -r build            # build every package (contract first, topologically)

cd apps/api
cp .env.example .env      # fill in DATABASE_URL (required) — see Configuration below
pnpm db:migrate           # apply migrations to your Supabase DB (idempotent; safe to re-run)
pnpm dev                  # http://localhost:4000/v7   (GET /health to verify)

# optional: seed dev data + validate triggers/RPC (asserts loudly on failure)
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seed.sql
```

The admin frontend: `cd apps/admin && pnpm dev` (http://localhost:5173) — set `VITE_API_BASE_URL`.

Other commands (from `apps/api`, or `pnpm --filter @agora/api <script>` from the repo root):

```bash
pnpm typecheck            # tsc --noEmit  — run before considering work done
pnpm build                # tsc -> dist/
pnpm db:generate          # after editing src/db/schema/*.ts -> a new migration in drizzle/
pnpm test                 # unit tests (no DB)
pnpm test:integration     # integration tests (needs TEST_DATABASE_URL — a dedicated cloud DB)
```

### Configuration (`.env`)

Only `DATABASE_URL` is strictly required; the rest gate specific features and are validated as
optional (empty strings are treated as unset).

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

# Observability (wonder-logger; configured in apps/api/wonder-logger.yaml)
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

## Docker

The api ships a multi-stage `Dockerfile` (`node:22-slim`; **built from the repo root** since it
depends on the `@agora/contract` workspace package — `pnpm deploy` bundles a prod-only standalone,
run as a non-root user with a `/health` healthcheck). Postgres/Auth/Storage are on Supabase, so
there's no local DB to run — the container just needs your `.env`.

```bash
docker compose up --build                               # from the repo root; api :4000 + admin :8080
docker compose run --rm agora node scripts/migrate.mjs  # apply migrations (one-off, drizzle-kit-free)
```

`compose` also builds the **admin** service — the Vite SPA on nginx (`agora-admin`), served on
`:8080`, which reverse-proxies `/v7` + `/socket.io` to the api container (same origin, no CORS).

Or without compose (build context = repo root):

```bash
docker build -f apps/api/Dockerfile   -t agora-api   .
docker run  --rm --init --env-file .env -p 4000:4000 agora-api

docker build -f apps/admin/Dockerfile -t agora-admin .
docker run  --rm -e API_UPSTREAM=http://<api-host>:4000 -p 8080:80 agora-admin
```

Migrations are applied via `scripts/migrate.mjs` (uses only runtime deps), so they run as a
**separate one-off task or init step rather than on container boot** — scaling to multiple replicas
won't race migrations against each other.

## Database

The schema lives in `apps/api/src/db/schema/*.ts` and is the single source of truth.
`drizzle-kit generate` emits table DDL; anything Drizzle can't express (triggers, RPC, RLS,
PostGIS) is a hand-written custom migration, applied in journal order and written **idempotently**
so re-runs are safe. Migrations `0000`–`0019` cover extensions + enums + tables, PostGIS columns/indexes,
denormalization triggers, RPC functions (`toggle_reaction`, `hot_score`, `fetch_comment_thread`,
`match_content`, `space_readable`, …), RLS (deny-all backstop + public-read + authenticated self-access),
refresh tokens, project webhooks, OAuth state, content embeddings, feed + moderation config, and the
score-recompute function.

To change the schema: edit `apps/api/src/db/schema/*.ts` → `pnpm db:generate` → `pnpm db:migrate`.
Edit triggers/functions/RLS/PostGIS by hand in their custom migration files.

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

## Client SDK

Clients talk to Agora through **[`agora-sdk`](https://github.com/jenova-marie/agora-sdk)** — a
TypeScript-first, headless fork of the Replyke SDK, repointed at an Agora server and published under
the `@agora-sdk/*` scope:

| Package | Use |
|---|---|
| `@agora-sdk/core` | core hooks, context providers, utilities (React + React Native) |
| `@agora-sdk/react-js` | React bindings + re-exports from core |
| `@agora-sdk/react-native` | React Native bindings with token management |
| `@agora-sdk/expo` | Expo bindings with secure token storage |

```bash
pnpm add @agora-sdk/react-js      # or @agora-sdk/react-native / @agora-sdk/expo
```

Point it at your server with `VITE_API_BASE_URL` (defaults to `http://localhost:4000/v7`) and pass a
`projectId` + a signed user token to the provider; the SDK's typed hooks (`useEntity`, `useComments`,
`useChat`, …) then work unchanged. See the [agora-sdk README](https://github.com/jenova-marie/agora-sdk#quick-start)
for a full quick-start. (`useSignTestingJwt` signs a token client-side for development only — sign
tokens on your server in production.)

**Why a fork?** The published Replyke SDK hardcodes `https://api.replyke.com/v7`; `agora-sdk`
repoints that base URL (see `docs/MANIFEST.md §0`). Because it does, the URL shape, auth token
semantics, `{ data, pagination }` / `{ error, code }` envelopes, response object shapes, and
socket.io event names all line up 1:1 — that's the entire point. `docs/MANIFEST.md` + `docs/MODELS.md`
are the contract both sides verify against.

**Compatibility harness.** The [`agora-demo`](https://github.com/jenova-marie/agora-demo) repo — a
standalone Vite + React app, also what powers the [live demo](https://demo.agora-oss.org) — is the
**1:1 proof**: eight tabs, each driving one SDK surface (feed, entity, spaces, search, chat,
connections, inbox, profile) against a running server. It installs the **published** `@agora-sdk/*`
(not a workspace link), so it catches any server↔SDK contract drift exactly as a third-party app
would. Point it at a local server with `VITE_API_BASE_URL=http://localhost:4000/v7` and sign in as
the seeded demo user.

## Status

- ✅ **Backend feature-complete** — every domain implemented and validated against live cloud
  Supabase; the REST surface has no remaining stubs.
- ✅ Realtime chat, semantic + RAG search, auth (token rotation + external RS256 + OAuth), storage,
  project webhooks, space digests, and RLS (public-read + authenticated self-access) verified end-to-end.
- ✅ **Access control** (see [Security](#security--access-control)) — space read/post privacy,
  private-chat membership gating (incl. search), configurable moderation-removal visibility, and the
  operator god-view, all enforced server-side and verified live against the RLS backstop.
- ✅ Idempotent Drizzle migrations `0000`–`0019`; unit + integration test suites green.
- ✅ Client SDK published + repointed — [`agora-sdk`](https://github.com/jenova-marie/agora-sdk)
  (`@agora-sdk/*`); validated 1:1 by the [`agora-demo`](https://github.com/jenova-marie/agora-demo)
  compatibility harness (the live proof at [demo.agora-oss.org](https://demo.agora-oss.org)).
- ✅ Hardening: env-configured edge rate limiting + a refresh-token cleanup sweep
  (`POST /internal/cron/purge-tokens` or `scripts/purge-tokens.mjs`).
- ⬜ Ops backlog: deployment, and RLS write policies (only needed if the Supabase Data API is opened
  for writes).

## License

[Apache-2.0](LICENSE) — matching Replyke.
