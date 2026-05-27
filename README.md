# 🏛️ Agora

> The open social layer. Own your community.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Built on Supabase](https://img.shields.io/badge/built%20on-Supabase-3ECF8E.svg)](https://supabase.com)
[![Status: feature-complete](https://img.shields.io/badge/backend-feature--complete-success.svg)](#status)

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
@agora/server  (Hono)   endpoints · business logic · permission checks
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

```
agora/
├── LICENSE              # Apache-2.0
├── docs/
│   ├── MANIFEST.md      # the exact REST + socket.io contract (SDK-confirmed vs inferred)
│   └── MODELS.md        # field-level response shapes (drive both the API and the schema)
├── db/README.md         # database overview (schema lives in server/src/db/schema)
└── server/              # @agora/server
    ├── drizzle/         # generated + hand-written SQL migrations (0000–0014)
    ├── scripts/         # seed.sql, send-digests.mjs, recompute-scores.mjs, *-e2e.mjs
    ├── test/            # vitest integration suites (real cloud Postgres)
    └── src/
        ├── index.ts     # entrypoint: serves the app + attaches socket.io
        ├── app.ts       # createApp() — side-effect-free Hono app (drives in-process tests)
        ├── db/          # Drizzle client + schema/*.ts (source of truth)
        ├── lib/         # env, supabase, tokens, embeddings, llm, storage, shape, validation, webhooks, digests, ranking, feed-config, recompute, rerank
        ├── http/        # error + pagination envelopes, context types
        ├── middleware/  # project resolution, JWT auth
        ├── routes/      # one router per domain
        └── realtime/    # socket.io server, typed to the SDK's event contract
```

This repository is the backend. The client SDK lives in a companion repository,
[`jenova-marie/agora-sdk`](https://github.com/jenova-marie/agora-sdk) (see **Client SDK** below).

## Getting started

```bash
cd server
cp .env.example .env      # fill in DATABASE_URL (required) — see Configuration below
npm install

npm run db:migrate        # apply migrations to your Supabase DB (idempotent; safe to re-run)
npm run dev               # http://localhost:4000/v7   (GET /health to verify)

# optional: seed dev data + validate triggers/RPC (asserts loudly on failure)
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seed.sql
```

Other commands:

```bash
npm run typecheck         # tsc --noEmit  — run before considering work done
npm run build             # tsc -> dist/
npm run db:generate       # after editing src/db/schema/*.ts -> a new migration in drizzle/
npm test                  # unit tests (no DB)
npm run test:integration  # integration tests (needs TEST_DATABASE_URL — a dedicated cloud DB)
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
CRON_SECRET=                                   # gates POST /internal/cron/digests (space digests)

# Semantic search — Voyage AI (optional)
VOYAGE_API_KEY=pa-...
VOYAGE_MODEL=voyage-3.5
EMBEDDING_DIMENSIONS=1024

# RAG /search/ask — Anthropic (optional)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_MAX_TOKENS=64000
```

## Docker

The server ships a multi-stage `Dockerfile` (`node:22-slim`; builds TypeScript, then runs a
prod-only image as a non-root user with a `/health` healthcheck). Postgres/Auth/Storage are on
Supabase, so there's no local DB to run — the container just needs your `.env`.

```bash
cd server
docker compose up --build                          # build + run on :4000
docker compose run --rm agora npm run db:migrate:run   # apply migrations (one-off, drizzle-kit-free)
```

Or without compose:

```bash
docker build -t agora-server .
docker run --rm --init --env-file .env -p 4000:4000 agora-server
```

Migrations are applied via `scripts/migrate.mjs` (uses only runtime deps), so they run as a
**separate one-off task or init step rather than on container boot** — scaling to multiple replicas
won't race migrations against each other.

## Database

The schema lives in `server/src/db/schema/*.ts` and is the single source of truth. `drizzle-kit
generate` emits table DDL; anything Drizzle can't express (triggers, RPC, RLS, PostGIS) is a
hand-written custom migration, applied in journal order and written **idempotently** so re-runs are
safe. Migrations `0000`–`0012` cover extensions + enums + tables, PostGIS columns/indexes,
denormalization triggers, RPC functions (`toggle_reaction`, `hot_score`, `fetch_comment_thread`,
`match_content`, …), RLS (deny-all backstop + public-read), refresh tokens, project webhooks, OAuth
state, content embeddings, and the score-recompute function.

To change the schema: edit `src/db/schema/*.ts` → `npm run db:generate` → `npm run db:migrate`.
Edit triggers/functions/RLS/PostGIS by hand in their custom migration files.

## Testing

[Vitest](https://vitest.dev), two tiers:

- **Unit** (`src/**/*.test.ts`) — pure logic (shapers, validation, envelopes, HMAC), no DB.
- **Integration** (`test/integration/**`) — runs against a real dedicated cloud Postgres via
  `TEST_DATABASE_URL`, driving the app in-process with `app.request()` (plus a booted socket.io
  server for the chat realtime suites). Isolation is by `project_id`: each test mints its own
  project + users and cascade-cleans on teardown.

```bash
npm test                  # unit
npm run test:integration  # integration (set TEST_DATABASE_URL first)
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
  project-admin **`GET`/`PATCH /settings/feed`**: `{ defaultAlgorithm, decayMode, halfLifeHours,
  gravity, reactionWeights, diversity, rerankWebhook }`.

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

## Status

- ✅ **Backend feature-complete** — every domain implemented and validated against live cloud
  Supabase; the REST surface has no remaining stubs.
- ✅ Realtime chat, semantic + RAG search, auth (token rotation + external RS256 + OAuth), storage,
  project webhooks, space digests, and RLS public-read all verified end-to-end.
- ✅ Idempotent Drizzle migrations `0000`–`0012`; unit + integration test suites green.
- ✅ Client SDK published — [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) (`@agora-sdk/*`),
  repointed at Agora (the 1:1 proof).
- ⬜ Hardening / ops backlog: rate limiting, refresh-token cleanup sweep, RLS write policies (only
  needed if the Supabase Data API is opened for writes), and deployment.

## License

[Apache-2.0](LICENSE) — matching Replyke.
