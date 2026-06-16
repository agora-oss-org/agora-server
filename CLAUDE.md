# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agora is a self-hosted, **Replyke-API-compatible** community/social backend. Goal: an API the
(forked) Replyke SDK consumes **1:1**, so the SDK's typed hooks work unchanged against your own
server. **The contract is the constraint** — match `docs/MANIFEST.md` (REST paths, envelopes,
socket.io events) and `docs/MODELS.md` (response shapes) exactly, or the SDK's typed hooks break.

## Engineering principles (NON-NEGOTIABLE)

These override convenience, brevity, and "just make it work." If a change can't satisfy both, stop
and raise it — don't ship the insecure or untested version.

### 🔒 Security first — ALWAYS

**Every line of code is written security-first. No exceptions.** When there's a tension between the
easy path and the safe path, take the safe path. Default to the secure choice and fail **closed**.

- **The server is the trust boundary.** Never trust client input — validate **and authorize** on the
  server for every request. The API runs as the RLS-bypassing owner role, so a missing handler check
  is a real hole; RLS is only defense-in-depth, never the primary gate.
- **Wire every gate on every new path.** A new endpoint/read/write MUST apply the matching checks:
  `requireAuth`, ownership (`ownedEntity`/…), space access (`lib/space-access.ts` read/post), and
  moderation visibility (`removedPolicy(c)` — never return raw `removed` rows). Adding a route without
  its gates is a defect, not a TODO.
- **Validate input with zod** (`parseBody` + contract schemas) at the boundary; reject, don't coerce.
- **Parameterize all SQL** through Drizzle/`sql` tags with explicit casts — never string-interpolate
  user input. Guard outbound fetches against SSRF (`lib/ssrf.ts`).
- **Least privilege & no leaks.** Never expose secrets, tokens, internal ids, or another user's PII in
  responses, logs, or errors (e.g. a steward respondent notification must never carry the complainant's
  identity). Don't print `.env` secrets — `grep` to the var and report status/length only.
- **Auth/crypto stays in the vetted libs** (`lib/tokens.ts`, jose, pinned alg) — don't hand-roll.
- See **`SECURITY.md`** for the full posture; new work must not regress anything documented there.

### 🧪 Test what deserves testing

**New code that would benefit from testing gets tests, in the same change — not "later."**

- **Pure/branching logic MUST ship with unit tests** (`src/**/*.test.ts`, vitest, no DB): policy
  matrices, guards, shapers, ranking, validation, envelopes. Examples to mirror:
  `lib/steward-notify.test.ts` (the notify matrix), `lib/mediation.test.ts` (`canOpenJoint`). If you
  add a pure function with real branches and don't test it, that's incomplete work.
- **Cross-cutting / DB-backed behavior** (handlers, permission gates, RPC visibility) gets an
  **integration test** under `test/integration/**` (real Postgres, isolated by `project_id`).
- **Security-relevant logic is the highest testing priority** — assert the *negative* cases too (the
  unauthorized caller is blocked, the removed row is hidden, the other party's id never leaks).
- **Before considering any work done:** `pnpm -r typecheck` **and** `pnpm test` must pass. Don't claim
  completion otherwise.

### 🪵 Log with intent

**Every failure path and operationally-significant event gets a log line — at the right level.** Use the
shared `logger` (`lib/logger.ts`; mechanics + Pino arg order in Handler conventions), never `console.*`.

- **`info` / `error` carry a MESSAGE ONLY** — a human-readable string, no raw error objects, stack
  traces, request bodies, or other payloads. These levels ship to aggregators by default, so they must
  stay leak-free: a stack or `err` object can carry secrets, tokens, or another user's PII (fails the
  Security-first rule). Make the message say *what* failed and *where*, not dump the exception.
- **`debug` carries the raw error / exception / context** — `logger.debug({ err, … }, "…")` is the *only*
  place the full object, stack, and diagnostic payload go. `debug` is off in production, so it's the safe
  home for detail when reproducing locally.
- **Pattern on a caught failure:** `logger.error("creating entity failed")` for the alertable signal,
  plus `logger.debug({ err }, "creating entity failed")` for the detail. Never put `{ err }` (or any
  raw payload) on an `info`/`error` call.

## Changelog (keep current)

`CHANGELOG.md` (repo root) MUST stay current. After any change that affects behavior, the API
contract, the schema/migrations, deployment, or tooling, add an entry under `## [Unreleased]` using
[Keep a Changelog](https://keepachangelog.com) sections (`Added`/`Changed`/`Fixed`/`Removed`). On
release, move the `[Unreleased]` items under the new `## [x.y.z] - DATE` heading, update the compare
links, and tag. Pure-internal refactors with no observable effect don't need an entry.

## Architecture

```
client + forked Replyke SDK
   │  HTTPS  /v7/:projectId/<domain>/...        (+ socket.io for chat realtime)
   ▼
@agora/api  (Hono)   endpoints + business logic + permission checks
   │  Drizzle ORM (postgres.js, Supabase transaction pooler :6543, prepare:false)
   ▼
Supabase Postgres   schema + triggers + RPC + pgvector + PostGIS
        └── @supabase/supabase-js is reserved for Auth + Storage ONLY (lazy getSupabase())
```

- **Drizzle owns all DB access** via a direct `postgres.js` connection (`apps/api/src/db/index.ts`).
  The Supabase JS client is *only* for Auth/Storage and is lazily constructed.
- **`auth.users` is NOT modeled in Drizzle** — `profiles.auth_user_id` is a plain uuid the app
  links, so Drizzle never tries to own the Supabase-managed `auth` schema.
- Multi-tenant by `project_id` (every table has it; the SDK addresses `/v7/:projectId/...`).
  A single-project deployment just has one `projects` row.

## Monorepo

pnpm workspaces (corepack-pinned `pnpm@10.14.0`). Three pnpm packages — plus the `services/scorer`
Python sibling:

- `apps/api` — `@agora/api`, the Hono backend (everything below; the reference package).
- `apps/admin` — `@agora/admin`, a Vite + React + TS admin frontend that consumes the API.
- `services/scorer` — the Python **content-moderation + social-graph subsystem** (NOT a pnpm package),
  which **replaces the retired `apps/moderator`**. Two responsibilities off one pgmq consumer loop:
  (1) **Moderation**: two RoBERTa classifiers gate a Claude Haiku adjudication; removals written back to
  the API (`POST /internal/moderation/apply`, `moderatedByType="client"`); `moderation_analyses` audit
  trail; operator-gated AI-flag queue at `/v1/:projectId/moderation/*` (admin AI tab). (2) **Social-graph
  edges**: projects `INTERACTED` / `FOLLOWS` / `CONNECTED` / `FRICTION` edges into Neo4j; the API reads
  them back for `GET /social/weather` + `GET /social/neighborhood` (see Social graph below).
  **Per-project tuning** lives in `projects.moderator_config` (auto-action thresholds + LLM-provider
  config; admin Settings → Moderator), overlaid on the scorer's env defaults. Shares the API's Postgres
  + `ACCESS_TOKEN_SECRET`; **all content mutations go through the API over HTTP**. See `docs/SCORER.md`
  and `docs/SOCIAL-GRAPH.md`.
- `packages/contract` — `@agora-server/contract`, the **shared API contract**: response-model TS types
  (`User`/`Entity`/`Comment`/`AuthUser`/`AuthContext`/`ModerationAnalysis`/`SocialWeather`/`SocialNeighborhood`),
  the reaction taxonomy, the pagination envelope + `paginate()`, the error-envelope shape, and the zod
  request schemas. Pure types + zod, **no hono/drizzle**. Built to `dist/` and consumed via its
  `exports` map by api and admin.

**Rule:** any API request/response type or zod schema shared between server and admin lives in
`packages/contract` (built first; `pnpm -r build` orders it). `apps/api`'s `shape.ts` /
`validation.ts` / `envelope.ts` / `context.ts` re-export the contract symbols so existing call sites
are unchanged — never redefine a contract type locally (that reintroduces drift).

Root `.env` is the single source (direnv `dotenv`), symlinked from `apps/api/.env -> ../../.env`.
`docker-compose.yml` lives at the repo root; the api image builds from the repo root context. Two
optional profiles: `--profile scale` adds Redis (cross-replica rate limiting), `--profile edge` adds a
**Caddy** TLS front door (auto-HTTPS + HSTS/headers + body cap + authoritative `X-Forwarded-For` →
admin; `deploy/proxy/`, set `RATE_LIMIT_TRUSTED_HOPS=2` behind it).

## Ecosystem (sibling repos)

Agora is **three separate repos** under `../` — kept separate on purpose, *not* one monorepo:

- **`agora-server`** (this repo) — the backend + admin. The contract's server side.
- **`../agora-sdk`** — the forked, repointed Replyke SDK, published as `@agora-sdk/*`
  (`core`/`react-js`/`react-native`/`expo`). Its own pnpm monorepo; base URL flows in via the
  `<ReplykeProvider baseUrl=… projectId=…>` prop (`setApiBaseUrl()`), no `api.replyke.com` left.
  **Don't edit it from here** — it's its own repo with its own release cycle.
- **`../agora-demo`** — a standalone **Vite + React** app: the **1:1 compatibility harness**. Eight
  tabs, each exercising one SDK surface (Feed/entity/Spaces/Search/Chat/Connections/Inbox/Me) against
  a running server. Manual/visual verification (no automated tests). npm, not pnpm.

**Why the demo stays separate:** a compatibility harness must be an *arms-length* consumer — it
installs the **published** `@agora-sdk/*` and catches server↔SDK contract drift exactly as a third
party would. Folding it in (and workspace-linking the SDK) would test local source you control, not
the published contract — defeating the point. Its `vite.config.ts` auto-aliases the local
`../agora-sdk/packages/*/dist` build when present, so SDK-fork dev still works without publishing.

**Run all three locally:** start the server (`cd apps/api && pnpm dev` → `:4000`), seed a confirmed
demo user (`node scripts/seeds/seed-demo-user.mjs` → `agora-admin@gmail.com` / `DemoPass123!`), then run the
demo (`cd ../agora-demo && npm run dev` → `:5173`, points at the server via `VITE_API_BASE_URL`).
Project id is the seed UUID `11111111-1111-1111-1111-111111111111`.

## Layout

- `docs/MANIFEST.md` — **the contract**: every REST endpoint (method+path, ✅SDK-confirmed vs
  🔶inferred), socket.io event names, auth/pagination/error envelopes, SDK fork points.
- `docs/MODELS.md` — field-level response shapes (source of truth for API output + schema).
- `packages/contract/src/*.ts` — shared types + zod schemas (`@agora-server/contract`); 1:1 with the docs above.
- `apps/api/src/db/schema/*.ts` — Drizzle schema, the **single source of truth** for the DB.
- `apps/api/drizzle/` — generated + custom SQL migrations (see DB section).
- `apps/api/src/lib/shape.ts` — row → camelCase API model shapers + batchers (`attachUserReactions`,
  `loadUsers`); `lib/validation.ts` — `parseBody()` + the zod schemas (re-exported from contract).
- `apps/api/src/http/` — `envelope.ts` (`paginate`/`readPagination`), `errors.ts` (`ApiError`/`Errors`), `context.ts`.
- `apps/api/src/middleware/` — `project.ts` (resolves `:projectId`), `auth.ts` (verifies JWT).
- `apps/api/src/routes/` — one router per domain; `realtime/socket.ts` — socket.io server
  (module singleton; REST handlers fan out via `emitToConversation()`).
- `apps/api/src/lib/` — also `tokens.ts` (mint/rotate Agora tokens), `embeddings.ts` (Voyage),
  `storage.ts` (Supabase Storage uploads), `supabase.ts` (lazy `getSupabase()`).
- `apps/api/src/lib/neo4j.ts` — `neo4jEnabled()` + lazy driver; returns `null` when `NEO4J_URI`
  unset. `lib/social-config.ts` — cached `getSocialConfig()` resolver + tier defaults/clamping.
  `lib/social-weather.ts` — Weather computation (warmth + FRICTION fold, decay, band hysteresis,
  1h cache). `lib/social-neighborhood.ts` — Neighborhood (dyadic brightness per tie, live, no cache).
- `apps/api/src/routes/social.ts` — `GET /social/weather`, `GET /social/neighborhood`,
  `GET /social/transparency`; `GET/PATCH /settings/social` (admin).

## Commands

```bash
# pnpm workspaces via corepack — `corepack enable` once. From the repo root:
pnpm install                 # install all workspaces
pnpm -r build                # build every package (contract first, topologically)
pnpm -r typecheck            # ALWAYS run before considering work done
pnpm --filter @agora-server/contract build   # rebuild the shared contract after editing it

cd apps/api                  # the backend lives here
pnpm dev             # tsx watch -> http://localhost:4000/v7  (loads .env via dotenv)
pnpm typecheck       # tsc --noEmit — ALWAYS run before considering work done
pnpm build           # tsc -> dist/

pnpm test                    # vitest unit suite (src/**/*.test.ts — pure fns, no DB)
pnpm test -- shape           # single file/pattern (vitest name filter)
pnpm test:integration        # real-Postgres suite (test/integration/**) — needs TEST_DATABASE_URL
pnpm test:cov                # unit suite + v8 coverage

pnpm db:generate     # after editing src/db/schema/*.ts -> new migration in drizzle/
pnpm db:migrate:run  # apply migrations — USE THIS, not db:migrate (drizzle-kit's journal schema is
                     # misconfigured; db:migrate:run is the runtime migrator the container also uses)

# Validate triggers/RPC + (re)seed dev data; asserts loudly on failure (run from apps/api):
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seeds/seed.sql
```

> ⚠️ `@agora/api` depends on `@agora-server/contract`'s built `dist/` (consumed via its `exports` map), so
> run `pnpm --filter @agora-server/contract build` (or `pnpm -r build`) before typechecking the api from a
> clean checkout.

**Env:** the root `.env` is the single source (direnv `dotenv`), symlinked from
`apps/api/.env -> ../../.env` so dotenv resolves from `apps/api/`. `DATABASE_URL` is the Supabase
**transaction pooler (:6543)** and is the only hard requirement. The rest gate specific features and
are validated as optional: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_ANON_KEY`
(Auth + Storage), `VOYAGE_API_KEY` (semantic search), `RATE_LIMIT_MAX`/`RATE_LIMIT_AUTH_MAX` (edge
rate limiting, off unless set), `OPERATOR_USER_IDS`/`OPERATOR_EMAILS` (deployment-operator allowlist),
`NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` (social graph — both scorer writes and API reads; unset →
scorer skips edge writes, `/social/*` endpoints return 503). Empty strings are treated as unset.

**Operators (deployment god-view).** `OPERATOR_USER_IDS`/`OPERATOR_EMAILS` (comma-separated profile
UUIDs / case-insensitive emails) are an env allowlist resolved by `lib/operators.ts` `isOperator()`.
The flag is stamped into the access JWT at mint time (`lib/tokens.ts`), read back in
`middleware/auth.ts`, and surfaces as **`c.var.auth.isOperator`** — so handlers get a project-wide
admin (all spaces/content/reports) with no extra DB hit. Independent of any space role; powers the
admin app and bypasses moderation-visibility filtering. Unset → no operators (everyone space-scoped).

**Stewards (conflict resolution).** A trust tier **between member and operator** powering the admin
**Steward** tab (a conflict-resolution caseload — distinct from moderation, which judges content).
Unlike operators (env), it's a **DB-backed grant**: `project_stewards`, where operators grant community
members (`POST /steward/stewards`). Resolved by `lib/stewards.ts` `isSteward(projectId, profileId)`,
stamped into the access JWT at mint/refresh (`lib/tokens.ts`), read back in `middleware/auth.ts` as
**`c.var.auth.isSteward`** (so a grant takes effect on the user's next token refresh, like the operator
flag). Privilege is **route-scoped** to `routes/steward.ts` (gated `isSteward||isOperator`) — stewards
do NOT inherit the operator's global read bypass. A case escalation removes the subject content via the
normal moderation path (`moderatedByType="user"`); outcomes otherwise stay restorative (repair /
separation / protection).

**Cron triggers** (`app.ts`, `CRON_SECRET`-gated, 503 until set): `/internal/cron/digests`,
`/internal/cron/recompute-scores`, `/internal/cron/purge-tokens` (delete expired refresh tokens),
`/internal/cron/community-stats` (hourly community-health rollup → `community_stats_hourly`, one row
per project per hour: flow counts + cumulative totals + leaderboard/top-post snapshots; re-derives a
trailing 25h window each run so a missed run self-heals — `lib/community-stats.ts`; read back by the
operator-only `GET /admin/community/overview` powering the admin **Community** dashboard).
Each also runs standalone via `scripts/*.mjs`. **Moderation write-back** (`app.ts`,
`MODERATION_SERVICE_SECRET`-gated, 503 until set): `POST /internal/moderation/apply` lets the
`services/scorer` service stamp `moderationStatus` + `moderatedByType="client"` on an entity/comment
(`lib/client-moderation.ts`). **Rate limiting** (`lib/rate-limit.ts` + `middleware/rate-limit.ts`,
mounted on `/v7/*`; stricter cap on `/auth/*`) keys on the real client IP read `RATE_LIMIT_TRUSTED_HOPS`
hops from the right of `X-Forwarded-For` (spoof-resistant), via a pluggable store: in-process by
default, or a shared **Redis** store when `REDIS_URL` is set (`lib/redis.ts`; fail-opens to in-memory).

**Mint a test JWT** (for authed routes; HS256 over `ACCESS_TOKEN_SECRET`, `sub`=userId):
```bash
SECRET=$(grep -E '^ACCESS_TOKEN_SECRET=' .env | cut -d= -f2-)
TOK=$(SECRET="$SECRET" node --input-type=module -e 'import {SignJWT} from "jose"; \
  process.stdout.write(await new SignJWT({role:"visitor"}).setProtectedHeader({alg:"HS256"}) \
  .setSubject("<USER_UUID>").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SECRET)))')
```
⚠️ Do NOT load the secret via `dotenv` inside a `$(...)` — its stdout banner (`◇ injected env…`,
non-ASCII) corrupts the value and yields an invalid HTTP header (400 before Hono). `grep` it.

**Tests (vitest, two suites).** `vitest.config.ts` runs the **unit** suite (`src/**/*.test.ts`) —
pure functions (shapers, validation, ranking, envelope, rate-limit), no DB; it feeds dummy
`DATABASE_URL`/`ACCESS_TOKEN_SECRET` so importing `lib/db`→`lib/env` (validates + lazily constructs
the postgres.js client at import) never touches a real DB. `vitest.integration.config.ts` runs
`test/integration/**` against a **real Postgres** (`TEST_DATABASE_URL`, a dedicated cloud Supabase
test project; it points the app's `DATABASE_URL` at it). Integration isolation is **by `project_id`**
— each test mints its own `projects` row and scopes everything to it; `fileParallelism:false` (one
shared DB) and `globalSetup` applies migrations on first run. The integration env **forces
`VOYAGE_API_KEY`/`ANTHROPIC_API_KEY` empty** so embed/LLM write paths are no-ops (hermetic — no real
Voyage/Anthropic calls); `match_content` is covered offline with synthetic vectors.

> ⚠️ **Temp-fs fill (`ENOSPC` on `/private/tmp`).** A full integration run (vitest reporter +
> per-worker temp files) can exhaust the small macOS `/private/tmp` volume and abort mid-suite with
> `ENOSPC`. Redirect temp output to a roomier dir for the run:
> `mkdir -p "$HOME/.cache/agora-tmp"` once, then prefix with `TMPDIR="$HOME/.cache/agora-tmp"`
> (e.g. `TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration`).

## Database migrations (Drizzle)

Schema lives in `apps/api/src/db/schema/*.ts`. `drizzle-kit generate` produces table DDL; anything
Drizzle can't express is a **hand-written custom migration** in `server/drizzle/`, applied in
journal order and written **idempotently** (`create extension if not exists`, `create or replace`,
`drop trigger if exists` before create):

- `0000_init` — extensions (vector/postgis/pgcrypto, prepended) + enums + tables + btree indexes
- `0001_postgis` — `geography(Point,4326)` columns + GIN/GiST/IVFFlat indexes (kept out of TS schema)
- `0002_triggers` — denormalized counts + reputation
- `0003_functions` — `toggle_reaction`, `hot_score`/`refresh_entity_score`, `fetch_comment_thread`, `match_content` (semantic search; later given visibility args by `0019`)
- `0004_rls` — enable RLS on all tables (deny-all backstop)
- `0005_refresh_tokens` — token rotation table (auth)
- `0006_message_report_enum` — extend `reaction_target` with `message` (chat-message reports)
- `0007_embeddings_1024` — `entity_embeddings.embedding` → `vector(1024)` (Voyage voyage-3.5)
- `0008_rls_public_read` — public SELECT policies (entities/comments/spaces/rules/follows/reactions); writes + private tables stay deny-all; `profiles` not exposed (column leak)
- `0017_rls_self_access` — (1) enablement backstop: dynamic guard enables RLS on every public base
  table (future tables deny-all by default); (2) `authenticated` self-read policies — a signed-in
  user reads only their own private rows (inbox/collections/connections/oauth/reports/uploads/space
  memberships + member-scoped conversations/messages/reactions). Maps `auth.uid()`→profiles via two
  `SECURITY DEFINER` helpers in a non-exposed `private` schema. No write policies (server-only).
- `0018_…moderation_config` — `projects.moderation_config jsonb` (once held the `hide` vs
  `placeholder` removed-content behavior; now unused — removed content is always hidden, the column
  is kept only to avoid a migration).
- `0019_rpc_visibility` — pushes read-path visibility **into SQL**: `space_readable(space, viewer)`
  predicate; `fetch_comment_thread(…, p_hide_removed)` prunes removed comments **and their subtrees**
  in the recursive CTE; `match_content(…, p_viewer, p_privileged, p_hide_removed)` filters semantic-
  search hits by space-readability + chat membership + moderation status (operators bypass).
- `0020_…` — `moderation_analyses` table + `moderation_verdict` enum (allow/block/review): the
  `services/scorer` service's automated-moderation audit trail + AI-flag queue.
- `0021_…` — (added `projects.moderation_webhook_url` + `moderation_webhook_secret` for the old
  per-project moderation notifier; **dropped again by `0035`** — `services/scorer` uses pgmq, not a
  webhook, so the columns are dead. See `docs/SCORER.md`.)
- `0022_…` — `projects.moderator_config` jsonb: per-project moderator tuning (`autoActionThreshold`
  + LLM provider config) that `services/scorer` overlays on its env defaults (admin Settings → Moderator).
- `0023_…` — `moderation_analyses.prompt_tokens` + `completion_tokens`: per-assessment LLM token usage,
  summed by the moderator's `GET /moderation/stats` for the dashboard's automated-moderation metrics.
- `0024_…` — `community_stats_hourly`: hourly community-health rollup (one row/project/hour) powering
  the operator-only Community dashboard (`lib/community-stats.ts`).
- `0025_…` — steward conflict-resolution: `project_stewards` (the steward grant) + `steward_cases` +
  `steward_case_events` (+ `steward_case_state` / `steward_case_outcome` / `steward_case_event_kind` enums).
- `0026_…` — `user_suspensions.profile_id` btree index: the suspension-enforcement lookup that now runs
  on every authenticated request (`lib/suspensions.ts` `hasActiveSuspension`).
- `0027_…` — **`services/scorer` pgmq enqueue**: `create extension pgmq` + the `scorer_jobs` queue +
  `enqueue_scorer_job()` trigger fn, attached as AFTER INSERT / **content-gated** UPDATE triggers on
  `entities`/`comments` (the UPDATE gate skips moderation/count writes so the write-back
  doesn't re-enqueue). Replaces the moderation webhook notifier; see `docs/SCORER.md`. (Chat messages are
  **not** scored — secure chat is E2E-encrypted, so the server has no plaintext to classify.)
- `0028_…` — **`services/scorer` analysis dedup**: `moderation_analyses.source_msg_id` (bigint) + a
  partial unique index. The worker stamps the pgmq message id and inserts `ON CONFLICT (source_msg_id)
  DO NOTHING`, so pgmq's at-least-once redelivery can't create duplicate analysis rows (kept out of the
  Drizzle schema like the `0001_postgis` columns — only the scorer's raw-SQL worker uses it).
- `0029`–`0032_…` — incremental schema fixes and the LISTEN/NOTIFY wake-up trigger
  (`pg_notify` on enqueue so the scorer drains instantly; `SCORER_LISTEN_DATABASE_URL` must be a
  direct `:5432` DSN — LISTEN does not work over the transaction pooler).
- `0033_…` — LISTEN/NOTIFY migration (scorer wake-up via `pg_notify`).
- `0034_…` — `collection_entities` same-project constraint (cross-tenant isolation fix).
- `0035_…` — drop the dead `moderation_webhook_url` / `moderation_webhook_secret` columns (added by
  `0021`, dropped here — scorer uses pgmq, not webhooks).
- `0036_…` — **scorer graph v2 enqueue**: `reactions` (insert/delete/retype-gated) + `follows`
  (insert/delete) triggers; routes `reaction`/`follow` jobs onto `scorer_jobs` with a `kind`
  discriminator. Self-interactions and chat-message-target reactions are skipped at trigger time.
- `0037_…` — **scorer `CONNECTED` edge**: `connections` triggers gated on the `pending→connected→
  declined` lifecycle — edge created on accept/direct-connect, deleted on disconnect (row DELETE).
- `0038_…` — `projects.social_config` jsonb: the social-graph privacy tier + per-surface enabled
  flags (`graphEnabled`, `weatherEnabled`, `neighborhoodEnabled`, warmth/friction half-lives).
  Tier defaults enforced at write (forbidden flags rejected) and clamped at read. Migration name is
  `0038_typical_speed_demon` (Drizzle auto-name).
- `0039_…` — **scorer `FRICTION` edge enqueue**: `AFTER INSERT ON reports` trigger projects a
  directed `(reporter)→[:FRICTION]→(subject)` job; MERGE-keyed on report id (idempotent).
- `0041`/`0042`/`0043_…` — **native auth provider** (managed-hosting sub-project A): `0041` adds
  `auth_credentials` + `auth_email_tokens` (Agora-owned password store; argon2id hashes, hashed
  single-use confirm/reset tokens) and `projects.auth_provider` enum (`supabase` default | `native`);
  `0042` adds `auth_credentials.updated_at`; `0043` enables RLS deny-all on both tables (the `0017`
  backstop is one-time, so new tables need explicit RLS). Provider selected per-project via
  `lib/auth/` (`getAuthProvider`). (`0040` is the separate `social_constellation` feature.)

To change schema: edit `src/db/schema/*.ts` → `db:generate` → `db:migrate`. Edit triggers/functions/
RLS/PostGIS by hand in their custom migration files. (Apply with `db:migrate:run` — the runtime
migrator the container uses; its journal is the `drizzle` schema.)

## Handler conventions (don't break these)

- **URL shape is fixed:** `/v7/:projectId/<domain>/...`. In a domain router, static routes
  (`/by-username`, `/root`, …) MUST be declared **above** `/:id` or Hono captures them.
- **Envelopes are contract.** Lists → `{ data, pagination }` via `paginate()`/`readPagination()`.
  Errors → throw `Errors.*` (→ `{ error, code, field? }`), never bare strings. (The **connections**
  module uses a *different* pagination shape — see MANIFEST §1/§3.)
- **Shape every row** through `lib/shape.ts` (`shapeUser/Entity/Comment/Space/...`) — camelCase,
  Date→ISO, derive `userReaction`/`isSaved`, blank deleted comments. Don't return raw Drizzle rows.
- **Denormalized counts are trigger-maintained** (`reaction_counts`, `replies_count`,
  `members_count`, `thread_reply_count`, `entity_count`, reputation) — never recompute per request.
- **Reactions** go through `toggle_reaction` RPC via `db.execute(sql\`select toggle_reaction(...)\`)`
  with explicit `::reaction_type`/`::uuid` casts; call `refresh_entity_score` after entity votes.
  Keep both v6 `upvotes[]`/`downvotes[]` and v7 `reaction_counts` (SDK exposes both).
- **Ownership/role checks live in handlers** (`ownedEntity`/`ownedComment`/`ownedCollection`,
  spaces' `requireSpaceRole` where owner⇒admin). Trust boundary is the server, not RLS.
- **Space access + posting** (`lib/space-access.ts`): gate reads behind `readingPermission`
  (`anyone`|`members`) and creates behind `postingPermission` (`anyone`|`members`|`admins`,
  `assertCanPostInSpace`) — both on the **server**, not RLS. Don't add a space-scoped read/write
  without wiring the matching check.
- **Moderation visibility** (`lib/moderation-visibility.ts`): a removed (`moderationStatus='removed'`)
  entity/comment is **always hidden** on reads for non-operators — omitted from lists via
  `excludeRemovedSql` and 404'd on single reads via `shouldHide`. Operators bypass (they review via
  the admin queue). List/feed paths filter in SQL; recursive/semantic reads delegate to the `0019`
  RPCs (`p_hide_removed`). Any new read path over moderatable content must apply `removedPolicy(c)` —
  don't return raw `removed` rows.
- **Auth:** `requireAuth`/`optionalAuth` only *verify* tokens; minting + refresh
  rotation/reuse-detection/30s-grace live in `lib/tokens.ts` (`refresh_tokens` table).
  Identity is backed by Supabase Auth via the lazy anon client.
- **Social graph gates** (`routes/social.ts`): config gate fires **before** infra gate — check
  `cfg.graphEnabled && cfg.<surface>Enabled` first (throw 400 `social/<surface>-disabled`), then
  check `neo4jEnabled()` (return 503 `social/graph-unavailable`). Never reverse this order.
  `getSocialConfig()` is cached; `neo4jEnabled()` is a cheap env check (no I/O).
- **Realtime is socket.io** — event names in `realtime/socket.ts` must stay byte-identical to
  `@replyke/core/types/socket.ts`; REST handlers fan out via `emitToConversation()` after writing.
- **Logging:** use the shared `logger` (`lib/logger.ts`, Pino via `@jenova-marie/wonder-logger`),
  never `console.*`. **Level policy (Engineering principles → Log with intent):** `info`/`error` are
  message-only; raw errors/exceptions/context go on `debug`. **Pino arg order is data-object-FIRST:**
  `logger.debug({ err }, "msg")` — a message-first call silently drops the data. Request logging is the
  `requestLog` middleware. Config is `wonder-logger.yaml`; `LOG_LEVEL`/`LOG_CONSOLE` (`aligned`|`json`) tune it.
- **Observability (OTel):** `src/instrument.ts` (the **first** import in `index.ts`, before
  http/db load) starts traces + metrics from `wonder-logger.yaml`. Two metrics worlds, kept separate:
  `lib/metrics.ts`/`api_usage` is per-project **product** metering (admin dashboard); OTel is the
  **ops** layer (service-level RED, Prometheus `:9464` + OTLP, no `project_id` label). `OTEL_*_ENDPOINT`
  point at a collector; `OTEL_SDK_DISABLED=true` disables it. A **third** sink, `lib/umami.ts`
  (`trackEvent`), pushes discrete **product-usage events** (signups/posts/comments/reactions/…) to an
  external Umami instance — fire-and-forget, no-op unless `AGORA_UMAMI_*` is set; events only, never
  per-request metering (that's `api_usage`). The **admin app** is instrumented too (its own Umami
  website via `AGORA_UMAMI_ADMIN_ID`, script injected at build by `apps/admin/vite.config`; custom
  events via `lib/analytics.ts`), and reads stats back through the operator-only proxy
  `GET /admin/umami/overview` (`lib/umami-reporting.ts`, holds the secret `AGORA_UMAMI_API_KEY`
  server-side) rendered on the admin **Analytics** page.

## Status

- ✅ **Foundation validated on cloud Supabase**: migrations applied + idempotent; triggers/RPC
  asserted by `scripts/seeds/seed.sql`; end-to-end HTTP verified.
- ✅ **Implemented handlers**: `entities`, `comments`, `users`, `follows`, `collections`,
  `notifications`, `reports`, `spaces`, `auth`.
- ✅ **Auth**: Supabase Auth backs identity (passwords + confirmation/reset emails); Agora mints
  its own tokens (`lib/tokens.ts`) with rotation/reuse-detection/30s-grace (`refresh_tokens` table).
  External (RS256) + token rotation are live-validated; Supabase-backed flows need
  `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY` set to test.
- ✅ **Chat**: REST conversations/members/messages/reactions in `chat.ts`; socket.io fan-out via
  `emitToConversation()` (module singleton in `realtime/socket.ts`). E2E-validated incl. realtime
  delivery (`scripts/chat-e2e.mjs`). Message reports use the `reaction_target` enum extended with `message`.
- ✅ **Search**: `search.ts` — `/content` (Voyage `voyage-3.5` @ 1024 dims embed query → `match_entities`
  pgvector RPC), `/spaces` + `/users` (ILIKE). `lib/embeddings.ts` embeds entities on create/update
  (fire-and-forget `indexEntityAsync`). Embedding column is `vector(1024)`; set `VOYAGE_API_KEY` to enable.
- ✅ **Storage**: `storage.ts` — POST `/storage` (multipart → Supabase Storage `agora` bucket → `files` row),
  POST `/storage/images` (sharp → webp original + thumbnail/small/medium variants). `lib/storage.ts`.
- ✅ **Misc**: `misc.ts` — `/oauth/identities` (list/delete), `/projects/lean`, `/utils/get-metadata`
  (OG/link preview, SSRF-guarded). Only `crypto/sign-testing-jwt` remains a stub (dev convenience).
- **REST surface is complete** and the backend is feature-complete.
- ✅ **RLS**: deny-all backstop on all tables + public-read (`0008`) + `authenticated` self-access
  reads + enablement guard (`0017`). Server bypasses RLS (the trust boundary); RLS is defense-in-depth.
- ✅ **Client SDK forked + repointed** — `../agora-sdk` (`@agora-sdk/*`), base URL repointed off
  `api.replyke.com` (MANIFEST §0), exercised 1:1 by the `../agora-demo` harness (see **Ecosystem**).
- 🌱 **Social graph (optional · Neo4j)** — `social_config` foundation, Community Weather
  (`GET /social/weather`), and Neighborhood (`GET /social/neighborhood`) are live; scorer projects
  `INTERACTED`/`FOLLOWS`/`CONNECTED`/`FRICTION` edges. Constellation + admin analytics are next.
  All surfaces env-gated behind `NEO4J_URI`; config-gated per-project via `projects.social_config`.

`apps/api/src/routes/entities.ts` is the reference for a fully-built domain router.

License: **AGPL-3.0-only** for the server (`@agora/api`/`admin` + `services/*`, e.g. `services/scorer`);
`@agora-server/contract` stays **Apache-2.0** as the permissive wire-contract surface the SDK builds on.
Contributions are DCO-signed (`git commit -s`), no CLA. Community edition is AGPL-3.0 forever.
