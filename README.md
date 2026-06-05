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
auth semantics, and socket.io events. You keep Replyke's opinionated feature set (posts, threaded
comments, reactions & feeds, follows & connections, nested spaces, real-time chat, notifications,
moderation, semantic search) and run it all on infrastructure you control, under a permissive license.

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

## What's inside

Agora is a **pnpm monorepo** — three apps and one shared contract package. Each has its own README
with setup, configuration, and development details:

| Package | What it is | Docs |
|---|---|---|
| **[`@agora/api`](apps/api)** | The backend — Hono + Supabase + socket.io. Every endpoint, permission check, and bit of business logic. The reference package. | [apps/api/README.md](apps/api/README.md) |
| **[`@agora/admin`](apps/admin)** | The admin dashboard — Vite + React. Moderation queue, feed tuning, webhook config, project health. | [apps/admin/README.md](apps/admin/README.md) |
| **[`@agora/moderator`](apps/moderator)** | Optional LLM content moderation — a standalone service that assesses content via webhooks and feeds the admin's AI queue. | [apps/moderator/README.md](apps/moderator/README.md) |
| **`@agora/contract`** | Shared API types + zod request schemas (no hono/drizzle). Built first; consumed by all three apps so wire shapes never drift. | — |

```
agora/
├── docs/
│   ├── MANIFEST.md      # the exact REST + socket.io contract (SDK-confirmed vs inferred)
│   └── MODELS.md        # field-level response shapes (drive both the API and the schema)
├── packages/
│   └── contract/        # @agora/contract — shared API types + zod schemas
└── apps/
    ├── api/             # @agora/api       — the backend
    ├── admin/           # @agora/admin     — the admin frontend
    └── moderator/       # @agora/moderator — the LLM moderation service
```

The client SDK lives in a **separate** companion repository,
[`jenova-marie/agora-sdk`](https://github.com/jenova-marie/agora-sdk) (see [Ecosystem](#ecosystem)).

## Quick start

```bash
corepack enable          # activate the pinned pnpm
pnpm install             # install all workspaces (from the repo root)
pnpm -r build            # build every package (contract first, topologically)

# Backend — the only hard requirement is a Supabase DATABASE_URL
cd apps/api
cp .env.example .env      # fill in DATABASE_URL
pnpm db:migrate           # apply migrations (idempotent; safe to re-run)
pnpm dev                  # http://localhost:4000/v7   (GET /health to verify)

# Admin dashboard (optional)
cd ../admin && pnpm dev   # http://localhost:5173

# LLM moderation (optional)
cd ../moderator && pnpm dev   # http://localhost:4001
```

Each app's README covers its own configuration, commands, and Docker image. Start with
**[apps/api](apps/api/README.md)** — it's the backend everything else points at.

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

@agora/admin ─(operator JWT)─▶ @agora/api          @agora/moderator ─(webhooks + write-back)─▶ @agora/api
```

- **Drizzle owns all DB access** via a direct `postgres.js` connection. The Supabase JS client is
  *only* for Auth/Storage and is lazily constructed.
- **The server is the trust boundary.** The API connects as the table-owner role (so RLS never
  constrains it) and enforces every ownership / role check in the handlers. RLS is enabled as
  defense-in-depth with public-read policies.
- **Multi-tenant by `project_id`** — every table has it; the SDK addresses `/v7/:projectId/...`. A
  single-project deployment just has one `projects` row.

See [apps/api/README.md](apps/api/README.md#architecture) for the full backend architecture and
handler conventions.

## Features

Every domain below is implemented and validated against live cloud Supabase. The **REST surface is
complete** — no stubbed endpoints remain.

| Domain | Highlights |
|---|---|
| **entities** | feed with full filter grammar + **pluggable ranking** (`hot`/`top`/`new`/`controversial`/`decay`/`gravity`/`wilson`/`bayesian`, per-project + per-request tunable), CRUD, drafts, foreign/short-id lookup, reactions, saved state |
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
| **moderation** | per-project removed-content visibility (hide / placeholder) + optional LLM auto-moderation via [`@agora/moderator`](apps/moderator) |

Denormalized counts (reaction counts, reply counts, member counts, thread counts, reputation) are
maintained atomically by Postgres **triggers** — never recomputed per request.

## Security & access control

The trust boundary is the server: it talks to Postgres as the RLS-bypassing owner role and enforces
every read/write rule in the handlers, with RLS underneath as a verified backstop.

- **Tokens** — Agora mints short-lived access tokens (30 m) + refresh tokens (30 d) with rotation,
  reuse-detection, and a 30 s racing-tabs grace window.
- **Anonymous reads, authenticated writes** — public content is readable without a token (matching
  Replyke's contract); every mutation is `requireAuth`.
- **Space privacy** — a members-only space is invisible to non-members on every path (feed, single
  reads, reactions, comment creation, semantic search).
- **Private chat** — conversation messages are readable only by active members, enforced on the REST
  routes *and* inside the search RPC.
- **Moderation visibility** — removed content is configurable per project: **hide** or **placeholder**.
- **Operators** — a deployment-operator allowlist grants a project-wide moderation/admin god-view.
- **RLS backstop** — denies `anon`/`authenticated` any private-space, removed, or draft row directly.

Full detail (including the OAuth callback setup) lives in
[apps/api/README.md](apps/api/README.md#configuration-env).

## Docker

The repo's `docker-compose.yml` builds and wires the whole stack — api (`:4000`), admin (`:8080`),
and moderator (`:4001`). Postgres/Auth/Storage are on Supabase, so there's no local DB to run.

```bash
docker compose up --build                               # from the repo root
docker compose run --rm agora node scripts/migrate.mjs  # apply migrations (one-off, drizzle-kit-free)
```

The admin service is the Vite SPA on nginx, reverse-proxying `/v7` + `/socket.io` to the api and
`/moderator` to the moderator (same origin, no CORS). Each app's README documents building and
running its image standalone.

For production, an **optional TLS edge proxy** (Caddy) gives the stack a single HTTPS front door with
**automatic Let's Encrypt certs**, HSTS + security headers, a body-size cap, and an authoritative
`X-Forwarded-For`. It's gated behind the `edge` compose profile (default deploy is unchanged):

```bash
# in .env: SERVER_NAME=your.domain  and  RATE_LIMIT_TRUSTED_HOPS=2
docker compose --profile edge up --build
```

See [`deploy/proxy/README.md`](deploy/proxy/README.md). (Optionally `--profile scale` adds Redis for
cross-replica rate limiting.)

## Ecosystem

Agora is **three separate repos** — kept separate on purpose, *not* one monorepo:

- **`agora-server`** (this repo) — the backend + admin + moderator. The contract's server side.
- **[`agora-sdk`](https://github.com/jenova-marie/agora-sdk)** — the forked, repointed Replyke SDK,
  published as `@agora-sdk/*` (`core` / `react-js` / `react-native` / `expo`). The base URL flows in
  via the provider prop; no `api.replyke.com` left. Its own release cycle.
- **[`agora-demo`](https://github.com/jenova-marie/agora-demo)** — a standalone Vite + React app: the
  **1:1 compatibility harness** (and what powers the [live demo](https://demo.agora-oss.org)). Eight
  tabs, each exercising one SDK surface against a running server. It installs the **published**
  `@agora-sdk/*` (not a workspace link), so it catches server↔SDK contract drift exactly as a
  third-party app would.

**Why a fork?** The published Replyke SDK hardcodes `https://api.replyke.com/v7`; `agora-sdk`
repoints that base URL (see `docs/MANIFEST.md §0`). Because it does, the URL shape, auth token
semantics, `{ data, pagination }` / `{ error, code }` envelopes, response object shapes, and
socket.io event names all line up 1:1 — that's the entire point.

Point the SDK at your server with `VITE_API_BASE_URL` (defaults to `http://localhost:4000/v7`) and
pass a `projectId` + a signed user token to the provider; the SDK's typed hooks (`useEntity`,
`useComments`, `useChat`, …) then work unchanged. See the
[agora-sdk README](https://github.com/jenova-marie/agora-sdk#quick-start) for a full quick-start.

## Status

- ✅ **Backend feature-complete** — every domain implemented and validated against live cloud
  Supabase; the REST surface has no remaining stubs.
- ✅ Realtime chat, semantic + RAG search, auth (token rotation + external RS256 + OAuth), storage,
  project webhooks, space digests, and RLS (public-read + authenticated self-access) verified end-to-end.
- ✅ **Access control** — space read/post privacy, private-chat membership gating (incl. search),
  configurable moderation-removal visibility, and the operator god-view, all enforced server-side.
- ✅ **Admin + moderation** — the admin dashboard and the optional LLM moderation service are wired
  and operator-gated.
- ✅ Idempotent Drizzle migrations `0000`–`0019`; unit + integration test suites green.
- ✅ Client SDK published + repointed — validated 1:1 by the
  [`agora-demo`](https://github.com/jenova-marie/agora-demo) compatibility harness.
- ⬜ Ops backlog: deployment guides, and RLS write policies (only needed if the Supabase Data API is
  opened for writes).

## Contributing

**Contributors welcome — Agora is built in the open, and we'd genuinely love your help.** 🌱
Bug fixes, new admin-app slices, docs, test coverage, deployment guides, or closing a contract gap
against Replyke — there's room to jump in, whatever your level.

- 🐛 **Found a bug or a contract mismatch?** [Open an issue](https://github.com/jenova-marie/agora-server/issues).
  For SDK-compat drift, include the endpoint and the expected-vs-actual shape from
  [`docs/MODELS.md`](docs/MODELS.md).
- ✨ **Want to build something?** Browse the [open issues](https://github.com/jenova-marie/agora-server/issues)
  or the **[Status](#status)** backlog. Friendly first areas: admin-app features, test coverage, and
  the deployment guide.
- 📋 **Before you start,** read **[CONTRIBUTING.md](CONTRIBUTING.md)** — dev setup, the contract
  rules, coding conventions, the migration workflow, and how to open a PR.

The one hard rule: **the contract is the constraint.** Any change to request/response shapes, REST
paths, or socket.io events must keep [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) working
1:1 — see [The contract is the constraint](#the-contract-is-the-constraint). Everyone is welcome here;
be kind, assume good faith, and build something we'd all want to use. 💜

## License

[Apache-2.0](LICENSE) — matching Replyke. By contributing, you agree your contributions are licensed
under the same terms.
