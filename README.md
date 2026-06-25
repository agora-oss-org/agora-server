<p align="center">
  <img src="assets/agora.png" alt="Agora logo" width="200" height="200" />
</p>

<h1 align="center">Agora</h1>

<p align="center"><em>The open social layer. Own your community.</em></p>

<p align="center">
  <a href="https://github.com/jenova-marie/agora-server/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/jenova-marie/agora-server/ci.yml?label=ci&logo=github&logoColor=white" alt="CI Status" /></a>
  <a href="https://demo.agora-oss.org"><img src="https://img.shields.io/badge/▶_live_demo-demo.agora--oss.org-7C3AED.svg" alt="Live demo" /></a>
  <a href="https://github.com/agora-oss-org/agora-server/wiki"><img src="https://img.shields.io/badge/📖_docs-wiki-7C3AED.svg" alt="Wiki" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-7C3AED.svg" alt="License: AGPL-3.0-only" /></a>
  <a href="https://supabase.com"><img src="https://img.shields.io/badge/built%20on-Supabase-3ECF8E.svg" alt="Built on Supabase" /></a>
  <a href="#status"><img src="https://img.shields.io/badge/backend-feature--complete-success.svg" alt="Status: feature-complete" /></a>
</p>

<p align="center">
  ▶️ <strong>Try it live: <a href="https://demo.agora-oss.org">demo.agora-oss.org</a></strong>
</p>

A working social app — sign in, browse the feed, comment, react, semantic-search, and chat in
realtime — all driven by the [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) against a live
Agora backend.

**Agora is an open-source, self-hosted, 1:1-compatible replacement for the closed source Replyke backend, built on Supabase.**

Replyke is a hosted backend for community & social features. Agora reimplements that backend so the
[`agora-sdk`](https://github.com/jenova-marie/agora-sdk) (a repointed fork of the Replyke SDK) talks
to **your** server instead of `api.replyke.com` — byte-for-byte the same REST paths, response shapes,
auth semantics, and socket.io events. You keep Replyke's opinionated feature set (posts, threaded
comments, reactions & feeds, follows & connections, nested spaces, real-time chat, notifications,
moderation & stewardship, semantic search) and run it all on infrastructure you control, under a
genuinely open license.

**AGPL-3.0 — and that's the whole point.** Replyke open-sources its *SDK* (Apache-2.0) but keeps the
backend you'd actually depend on closed and hosted. Agora is the entire backend, in the open, under a
license with teeth: self-host it freely, forever — but anyone who runs a modified Agora as a service
has to share their changes back. No vendor lock-in, no per-seat pricing, no data leaving your project,
and no "open-source" asterisk. **The community edition is AGPL-3.0 and always will be.**

## Why

Supabase hands you ~40% of a social backend for free: Postgres, Auth (GoTrue), Storage, Realtime
infrastructure, and pgvector. The other ~60% — the social schema, the denormalized counts, the
permission model, and the opinionated endpoints that sit in front of all of it — is what makes
Replyke worth using. **That 60% is what Agora builds**, and it's the part you'd otherwise rent.

## Governance is first-class, not a bolt-on

Most community backends — Replyke included — ship content and social primitives and leave *governance*
to you: you build the reporting flow, the moderation dashboard, and any conflict-resolution process
yourself, against whatever the hosted API exposes. A real community can't run without these, so Agora
makes them **core surface area** — endpoints, schema, and admin UI in the box, enforced at the server
trust boundary rather than reconstructed per app:

- **Moderation** — report queues for entities, comments, and chat messages; server-enforced
  removed-content hiding (a removed row is omitted from every list, 404'd on single reads, and filtered
  inside the semantic-search RPC — operators bypass to review); space-scoped moderator roles plus a
  project-wide operator god-view; and **AI Agent Moderator** that assesses all new content for
  inappropriate violations (configurable categories, confidence thresholds) and either **auto-hides** or
  **flags for human review** depending on the AI score (tunable per-project in Settings) — escalates to
  the Stewardship caseload for conflict resolution.
- **Stewardship** — a distinct **conflict-resolution** layer: moderation judges *content*; stewardship
  tends *people and relationships*. A DB-granted **steward** role between member and operator; a
  **caseload** that moves a dispute (complainant ↔ respondent over some content) through
  `open → in_mediation → closed` with **transformative-ordered outcomes** (repair → separation →
  protection → escalation); an **asymmetry / "targeting"** flag for power-aware, anti-false-balance
  handling; **private mediation channels** — built on the existing chat — to actually talk a conflict
  through (1:1 *caucus* with each party, or a consensual *joint room* in hybrid mode, never for a
  targeting case); **configurable participant notifications** (power-aware / symmetric / resolution-only)
  that keep the parties informed without ever leaking who raised a case; an append-only case timeline;
  and **escalate-to-removal** that takes the subject content (post, comment, or chat message) down
  through the moderation path. All of it operator-tunable per project. See
  [`docs/STEWARDSHIP.md`](docs/STEWARDSHIP.md).

Both live behind the same `/v7/:projectId/...` contract and in the Postgres schema, so they're available
to every client from day one — not gated behind an external service's limits.

## Private means private — end-to-end-encrypted chat

A community backend that keeps everyone's direct messages in **readable plaintext** is a breach waiting
to happen: one database leak, one subpoena, one over-broad admin, one "smart" feature that quietly reads
DMs, and the trust is gone. Storing readable private messages is the bad default we refuse to ship — so
Agora's **secure chat** is genuinely **end-to-end encrypted**, and the server *cannot read it*.

It's built as a **blind delivery service** on **MLS (RFC 9420)** — the IETF messaging-layer-security
standard, the same family of guarantees as Signal but designed for large, dynamic groups:

- **The server is blind.** It stores and relays only **opaque ciphertext**. It enforces *who* may post
  and the *order* of group changes, but never sees *what* — it learns social-graph + timing metadata
  only (the Signal-server model). All cryptography is client-side; the server depends on no crypto library.
- **No AI in your DMs — on purpose.** Secure chat runs **no** LLM moderation, embeddings, or semantic
  search. Those features require reading content, which is exactly the thing we're refusing to do. That
  trade is the point, not a limitation.
- **A separate path *and* a separate process, zero contract drift.** Secure chat lives at
  `/v7/:projectId/secure-chat/*`, entirely apart from the Replyke-compatible plaintext chat (which is
  untouched), and runs as its own deployable service ([`@agora/secure-chat`](apps/secure-chat)) so the
  blind relay can be isolated and scaled on its own. Use whichever a conversation needs.
- **Your keys, your history.** Keys live on the client. Two recovery paths — both opaque to the server —
  restore history onto a re-provisioned device: an optional **passphrase-encrypted backup**, and
  **device-to-device history restore** (a peer seals your back-history into an ephemeral, targeted blob
  the server relays blindly; see [`apps/secure-chat/docs/RESTORE.md`](apps/secure-chat/docs/RESTORE.md)).
  The schema is multi-device-ready.
- **The crypto stays swappable.** All MLS lives behind a small `SecureChatCrypto` interface, so the
  concrete core (ts-mls vs OpenMLS-WASM) is a deferred, reversible choice — the server never changes.

Full design, threat model, schema, endpoints, and roadmap: **[`docs/SECURE_CHAT.md`](docs/SECURE_CHAT.md)**.

## Your social graph, pointed back at the community — not at you

Every platform mines the social graph *at* the user — to target, rank, and sell them. Agora points the
same structure **back at the community, for the community**, in service of its health. It's an
**optional, off-by-default** layer: wire up a Neo4j instance (`NEO4J_URI`) and the **Garden** comes
alive; leave it unset and nothing in the graph layer runs (every `/social/*` endpoint cleanly 503s and
the admin panels stay hidden).

There's a second purpose, just as deliberate: **to teach by showing.** Every member already *lives*
inside a social graph on every platform they use — they just never get to see it. That graph is the
asset being silently harvested, scored, brokered, and turned back on them as targeted advertising and
behavioral nudging, with their consent buried in a terms-of-service no one reads. By rendering the
graph **in the open, for once aimed at the community's wellbeing instead of at extracting from it**,
the Garden makes the thing concrete: *this* is what a map of who-talks-to-whom looks like, *this* is
how much it reveals, and *this* is exactly the structure that surveillance-capitalism platforms mine
and sell without ever letting you look at it. Seeing it pointed at *care* is the clearest way to grasp
how dangerous it is when it's pointed at *profit* — and how flatly that use conflicts with the
interests of the people it's built from. The Garden is consciousness-raising as much as it is a feature:
data literacy you can feel, not a lecture.

The whole design exists because Agora's communities skew **trans, queer, sex-worker, and recovery** —
for them graph exposure is a doxxing/outing vector, and mass-reporting is the primary harassment
tactic (any score that counts reports lights up on the *target*, not the harasser). So every rule
bends toward one non-negotiable:

> **The asymmetry principle — every possible misreading must land on *kindness*, never a scarlet
> letter.** Friction only ever *dims* a node; it never reddens it.

- **One public signal: warmth.** Loneliness and conflict both render as *dim* — indistinguishable on
  purpose, because both mean "bring care here." There is no per-person "bad actor" score, in any view.
- **A zoom ladder that is a privacy ladder.** ☀️ **Community Weather** (one project-wide warmth scalar
  with band + trend) → 🏡 **Neighborhood** (your *own* ties only, each rendered by its **dyadic**
  brightness `B(you, them)` — never the friend's global score, which closes the friction side-channel
  entirely). *(✨ Constellation — anonymous cluster blobs — is designed and next.)*
- **Friction is quarantined and decays.** A user report projects a directed `FRICTION` edge that can
  only *dim* an existing tie and fades at a ~14-day half-life ("a bad week is not a permanent
  identity"); it never creates a tie, and never becomes a per-person verdict.
- **One graph, opposite deployments.** The same structure serves a **vulnerable-population community**
  and a **corporation's internal platform** — nearly opposite privacy needs — resolved by a per-project
  `social_config` **tier** (community ↔ corporate, admin Settings → Social Graph), not by picking a side.

Under the hood the **scorer** owns the write side (it projects `INTERACTED` / `FOLLOWS` / `CONNECTED` /
`FRICTION` edges into Neo4j off the same pgmq queue it already scores content on), and `@agora/api`
owns the read side (`/v7/:projectId/social/*`, member/operator-gated, computed live or cached with band
hysteresis). Full design, ethics, and threat model:
**[`docs/SOCIAL-GRAPH.md`](docs/SOCIAL-GRAPH.md)** (the consolidation plan),
**[`docs/AGORA-SOCIAL.md`](docs/AGORA-SOCIAL.md)** (the condensed design corpus), and
**[`docs/DOZERDB.md`](docs/DOZERDB.md)** (DozerDB + OpenGDS setup — plugins, memory tuning, TLS).

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

Agora is a **pnpm monorepo** — three apps and two shared packages. Each app has its own README
with setup, configuration, and development details:

| Package | What it is | Docs |
|---|---|---|
| **[`@agora/api`](apps/api)** | The backend — Hono + Supabase + socket.io. Every endpoint, permission check, and bit of business logic. The reference package. | [apps/api/README.md](apps/api/README.md) |
| **[`@agora/secure-chat`](apps/secure-chat)** | The **independently-deployable end-to-end-encrypted chat service** — its own Hono + socket.io process serving `/v7/:projectId/secure-chat/*` (a reverse proxy routes that prefix to it) and the `/secure` realtime namespace on engine.io path `/secure-socket/`. A blind MLS delivery service that stores/relays only ciphertext; consumes `@agora/core`. | [apps/secure-chat/README.md](apps/secure-chat/README.md) |
| **[`@agora/admin`](apps/admin)** | The admin dashboard — Vite + React. Moderation queue + AI queue, the **stewardship caseload** (cases, mediation channels, steward grants), feed tuning, webhook config, community & analytics dashboards, plus the optional **Social Graph** panel + **Community Weather** card (gated on `VITE_SOCIAL_GRAPH_ENABLED`). | [apps/admin/README.md](apps/admin/README.md) |
| **`@agora/core`** | The **shared kernel** consumed by both `@agora/api` and `@agora/secure-chat`: env schema, logger, the Drizzle db client + full schema (single source of truth for all tables), http error/context, auth + project middleware, validation, suspensions (incl. the Redis fail-closed index), and the Redis client. | — |
| **`@agora-server/contract`** | Shared API types + zod request schemas (no hono/drizzle). Built first; consumed across the workspace — and the permissive (Apache-2.0) wire surface the SDK builds on. | — |

```
agora/
├── docs/
│   ├── MANIFEST.md          # the exact REST + socket.io contract (SDK-confirmed vs inferred)
│   ├── MODELS.md            # field-level response shapes (drive both the API and the schema)
│   ├── SECURE_CHAT.md       # the end-to-end-encrypted chat design + reference
│   ├── STEWARDSHIP.md       # the conflict-resolution caseload design
│   ├── SCORER.md            # the Python moderation + social-graph subsystem (services/scorer)
│   ├── SOCIAL-GRAPH.md      # the optional Neo4j social-graph layer ("the Garden")
│   ├── SELF-HOSTING.md      # run fully self-contained (native auth · S3/MinIO · local Postgres)
│   └── DOZERDB.md           # DozerDB + OpenGDS setup (plugins, memory tuning, TLS)
├── packages/
│   ├── contract/            # @agora-server/contract — shared API types + zod schemas
│   └── core/                # @agora/core   — shared kernel (env · logger · db+schema · auth · suspensions · redis)
└── apps/
    ├── api/                 # @agora/api          — the backend
    ├── secure-chat/         # @agora/secure-chat  — the E2E-encrypted chat service (own process)
    └── admin/               # @agora/admin        — the admin frontend
```

> The **client** secure-chat packages (`@agora-sdk/secure-chat-crypto` — the `SecureChatCrypto` seam +
> mock, with the real ts-mls/OpenMLS core to come) live in the separate **`agora-sdk-plus`** repo, not
> here; this repo only devDepends on the mock for tests. See [Ecosystem](#ecosystem) and
> [`docs/SECURE_CHAT.md`](docs/SECURE_CHAT.md).

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
pnpm db:migrate:run       # apply migrations (idempotent; safe to re-run)
pnpm dev                  # http://localhost:4000/v7   (GET /health to verify)

# Admin dashboard (optional)
cd ../admin && pnpm dev   # http://localhost:5173
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
        pgmq ──▶ services/scorer ──▶ AI moderation · social-graph edges ──▶ Neo4j   (optional)
                                                  @agora/api reads Neo4j back for /social/*

@agora/admin ─(operator JWT)─▶ @agora/api
```

- **Drizzle owns all DB access** via a direct `postgres.js` connection. The Supabase JS client is
  *only* for Auth/Storage and is lazily constructed.
- **The server is the trust boundary.** The API connects as the table-owner role (so RLS never
  constrains it) and enforces every ownership / role check in the handlers. RLS is enabled as
  defense-in-depth with public-read policies.
- **Multi-tenant by `project_id`** — every table has it; the SDK addresses `/v7/:projectId/...`. A
  single-project deployment just has one `projects` row.
- **Supabase is the default, not a hard dependency.** Auth and Storage sit behind provider seams
  (`getAuthProvider()` / `getStorage()`): choose **native** email/password auth
  (`DEFAULT_AUTH_PROVIDER=native`) and an **S3-compatible** object store (`STORAGE_PROVIDER=s3` →
  MinIO/AWS) and the *same* server runs fully self-contained on a local Postgres — no Supabase at all.
  See [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

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
| **secure chat** | **end-to-end-encrypted** chat (MLS / RFC 9420) on a separate path **and a separate process** (the independently-deployable [`@agora/secure-chat`](apps/secure-chat) service) — the server stores/relays only ciphertext and never reads content; 1:1 + groups + space channels, one-time key packages, passphrase + device-to-device history restore, a dedicated `/secure` socket.io namespace (engine.io path `/secure-socket/`) ([`docs/SECURE_CHAT.md`](docs/SECURE_CHAT.md)) |
| **search** | semantic content search across entities/comments/messages (Voyage + pgvector), RAG `/ask` (Anthropic, SSE), text search for spaces/users |
| **storage** | file uploads + image variants (sharp → webp, 5 sizing modes); **pluggable backend** — Supabase Storage or any S3-compatible store (MinIO/AWS) via `STORAGE_PROVIDER` |
| **webhooks** | project webhooks (HMAC validation gates + `*.complete` broadcasts) + per-space digests |
| **moderation** | report resolution + server-enforced removed-content hiding (lists, single reads, **and** the search RPC); space-moderator + operator roles; **AI Agent Moderator** that flags inappropriate content on post — configurable violation categories, confidence thresholds, and auto-actions (immediate hide or human review) — tunable per-project in Settings; escalation to Stewards for conflict resolution |
| **stewardship** | first-class **conflict resolution** — a DB-granted steward role (between member and operator), a caseload (`open → in_mediation → closed`), transformative outcomes, a "targeting" power-imbalance flag, **private mediation channels** (caucus + consensual joint room, built on chat), **configurable participant notifications** (power-aware/symmetric/resolution-only, never leaking who raised a case), append-only timeline, and escalate-to-removal for posts/comments/chat messages ([`docs/STEWARDSHIP.md`](docs/STEWARDSHIP.md)) |
| **social graph** *(optional · Neo4j)* | the **Garden** — community-health analytics pointed *back at the community*: **Community Weather** (project-wide warmth scalar + band/trend, cached with hysteresis) and **Neighborhood** (your own ties by **dyadic** brightness); one public signal (warmth), friction quarantined + decaying, per-project privacy **tier** (community ↔ corporate). Scorer projects the edges, the API reads them. Off unless `NEO4J_URI` is set ([`docs/SOCIAL-GRAPH.md`](docs/SOCIAL-GRAPH.md)) |

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
- **End-to-end-encrypted secure chat** — an optional, separate chat surface where the server stores only
  **ciphertext** and *cannot* read messages at all (MLS / RFC 9420; deny-all RLS on every secure table).
  See [`docs/SECURE_CHAT.md`](docs/SECURE_CHAT.md).
- **Moderation visibility** — removed content is always hidden from non-privileged readers (omitted from
  lists, 404'd on single reads, filtered in the search RPC); operators bypass to review.
- **Operators & stewards** — a deployment-operator allowlist grants a project-wide moderation/admin
  god-view; a DB-granted **steward** role (between member and operator) is route-scoped to the
  conflict-resolution caseload.
- **RLS backstop** — denies `anon`/`authenticated` any private-space, removed, or draft row directly.

Full detail (including the OAuth callback setup) lives in
[apps/api/README.md](apps/api/README.md#configuration-env).

## Docker

> 📋 **[`docs/CHEAT-SHEET.md`](docs/CHEAT-SHEET.md)** maps every deployment recipe to the env vars it needs and
> where to obtain each value — start there if you just want to stand a stack up.

The repo's `docker-compose.yml` builds and wires the whole stack with a **two-axis profile model**, so a
bare `docker compose up` starts nothing:

- **Axis 1 — data plane + API (required, pick exactly one):** `supabase` (external Supabase Postgres +
  Storage) or `selfhost` (local Postgres + MinIO). Either brings up the API itself — api (`:4000`), the
  Caddy front door (`proxy`), and cron.
- **Axis 2 — optional add-ons (compose freely on top):** `scorer` (moderation + social graph: scorer ×3 +
  neo4j), `secure-chat` (the E2E delivery process + redis), `scale` (Redis rate-limit store), or `full` =
  every add-on at once.

With Supabase backing Postgres/Auth/Storage there's no local DB to run:

```bash
docker compose --profile supabase up --build            # just the API, Supabase-backed
docker compose run --rm agora node scripts/migrate.mjs  # apply migrations
```

The **`proxy`** service is a **Caddy front door** — the single public entrypoint that serves the admin SPA
(baked into its image) and routes every service (`/v7` + `/socket.io` → api, secure-chat, `/moderator`,
`/media`), with **automatic Let's Encrypt certs**, HSTS + security headers, a body-size cap, and an
authoritative `X-Forwarded-For` (one hop → set `RATE_LIMIT_TRUSTED_HOPS=1`). It rides the data-plane
profiles, so it's up whenever the API is. Each app's README documents building its image standalone.

The **`secure-chat`** profile is the **standalone [`@agora/secure-chat`](apps/secure-chat)** deploy — Redis
+ the secure-chat process (`:4002`), no API stack. Like `agora`, it doesn't bundle a database: it persists
the `secure_*` tables to whatever **`DATABASE_URL`** points at, which in v1 is the **shared main Postgres**
(or Supabase) — already migrated. Alongside the API it travels in `full`, so a `full` deploy routes
`/v7/:projectId/secure-chat/*` + the WebSocket `/secure-socket/` to it through the Caddy front door
automatically.

```bash
docker compose --profile secure-chat up --build         # split box → remote DATABASE_URL, no API
docker compose --profile full --profile supabase up     # everything (incl. secure-chat), Supabase-backed
```

For a **fully self-contained** stack (no Supabase at all) use **`selfhost`** (local Postgres + MinIO).
Agora swaps Supabase out through its provider seams — **native** email/password auth
(`DEFAULT_AUTH_PROVIDER=native`) and **S3-compatible** storage (`STORAGE_PROVIDER=s3` → MinIO/AWS) — so
the *same* server image runs against either backend. See [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md):

```bash
docker compose --profile selfhost up --build            # just the API, self-contained
docker compose --profile full --profile selfhost up     # + every optional add-on
```

For a real domain set `SERVER_NAME=your.domain` (DNS → this host so ACME can validate on :80). For Tor
hidden services — or any deploy where Let's Encrypt can't reach you — a second
[`Caddyfile.onion`](deploy/proxy/Caddyfile.onion) serves a cert you supply at startup instead of
auto-ACME (selected via the `CADDYFILE` env var); plain HTTP behind your own TLS terminator: set
`SERVER_NAME=:80`. See [`deploy/proxy/README.md`](deploy/proxy/README.md). (Optionally add `--profile
scale` for Redis as the cross-replica rate-limit store.)

## Ecosystem

Agora is **three separate repos** — kept separate on purpose, *not* one monorepo:

- **`agora-server`** (this repo) — the backend + admin. The contract's server side.
- **[`agora-sdk`](https://github.com/jenova-marie/agora-sdk)** — the forked, repointed Replyke SDK,
  published as `@agora-sdk/*` (`core` / `react-js` / `react-native` / `expo`). The base URL flows in
  via the provider prop; no `api.replyke.com` left. Its own release cycle.
- **`agora-sdk-plus`** — additive, Agora-only SDK features built on `@agora-sdk/*` (kept out of the
  Replyke fork so that stays a tiny, documented divergence). Home of **end-to-end-encrypted chat**:
  `@agora-sdk/secure-chat-crypto` (the `SecureChatCrypto` seam + mock; real ts-mls/OpenMLS core to come)
  and the transport/provider/hooks. Depends on `@agora-server/contract` for the wire types — never the reverse.
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
  server-enforced removed-content hiding, the operator god-view, and the route-scoped steward role,
  all enforced server-side.
- ✅ **Governance** — moderation (report queues + optional LLM auto-moderation) and the stewardship
  caseload (cases, private mediation channels, participant notifications) are wired and operator-gated
  in the admin dashboard.
- 🌱 **Social graph (optional · Neo4j)** — the `social_config` foundation, **Community Weather**, and
  **Neighborhood** are live and env-gated behind `NEO4J_URI` (scorer writes the `INTERACTED` / `FOLLOWS`
  / `CONNECTED` / `FRICTION` edges, the API reads them); Constellation + admin graph analytics are
  designed and next ([`docs/SOCIAL-GRAPH.md`](docs/SOCIAL-GRAPH.md)).
- ✅ **Supabase-optional** — provider seams run the same server on **native** email/password auth
  (`DEFAULT_AUTH_PROVIDER=native`) + **S3-compatible** storage (`STORAGE_PROVIDER=s3`) + a local
  Postgres, fully self-contained; DB layer validated end-to-end ([`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)).
- ✅ Idempotent Drizzle migrations `0000`–`0048`; unit + integration test suites green.
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
- 📖 **New here?** The **[wiki](https://github.com/agora-oss-org/agora-server/wiki)** is a curated
  handbook (getting started, deployment, architecture, the subsystems) that links into the deep `docs/`.
  Its source lives in `wiki/` and is auto-published — edit it via PR, see [CONTRIBUTING.md](CONTRIBUTING.md#editing-the-wiki).

The one hard rule: **the contract is the constraint.** Any change to request/response shapes, REST
paths, or socket.io events must keep [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) working
1:1 — see [The contract is the constraint](#the-contract-is-the-constraint). Everyone is welcome here;
be kind, assume good faith, and build something we'd all want to use. 💜

## License

**[AGPL-3.0-only](LICENSE)** for the server (`@agora/api`, `@agora/admin`) — you
can self-host forever, but running a *modified* Agora as a network service means sharing your changes
back. The shared wire contract ([`@agora-server/contract`](packages/contract)) stays **Apache-2.0** so the
[`agora-sdk`](https://github.com/jenova-marie/agora-sdk) and any third-party client can build against
it freely. **The community edition is AGPL-3.0 and always will be.**

Contributions are accepted under the **[Developer Certificate of Origin](https://developercertificate.org/)** —
sign off your commits with `git commit -s`. There is **no CLA**: your contributions stay yours,
licensed AGPL-3.0, and they can't be relicensed out from under you. See
[CONTRIBUTING.md](CONTRIBUTING.md#licensing).

> **AGPL §13 note for operators:** because users interact with Agora over a network, your deployment
> must offer them its corresponding source. Agora surfaces a source link by default — keep it pointing
> at your fork.
