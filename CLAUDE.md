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

pnpm workspaces (corepack-pinned `pnpm@10.14.0`). Five pnpm packages — plus the `services/scorer`
Python sibling:

- `apps/api` — `@agora/api`, the Hono backend (everything below; the reference package).
- `apps/secure-chat` — `@agora/secure-chat`, the **blind MLS (E2E) Delivery Service** as its OWN
  deployable process (own Hono server + own socket.io server), split out of the api for load-balancing
  / solo deploys. Serves `/v7/:projectId/secure-chat/*` (REST) + the `/secure` realtime on its OWN
  engine.io path **`/secure-socket/`** (socket.io namespaces can't be path-split across processes, so a
  distinct path is what the proxy routes). v1 shares the main Postgres + Redis; onion / standalone-DB is
  v2. See `apps/secure-chat/README.md` + `docs/SECURE_CHAT.md`. **The secure-chat route/socket/shape code
  lives here now, NOT in `apps/api`.**
- `packages/core` — `@agora/core`, the **shared server kernel** both `@agora/api` and `@agora/secure-chat`
  consume: env schema, logger (+ `wonder-logger.yaml`), the Drizzle **db client + full schema** (single
  source of truth for all tables, incl. `secure_*`), http error/context, auth + project middleware,
  validation/`parseBody`, suspensions (read + Redis index), and the Redis client. `apps/api` re-exports
  each moved module via a thin shim at its old path (e.g. `src/db/index.ts` → `export * from
  "@agora/core/db"`), so existing import sites are unchanged. Build order: contract → core → (api,
  secure-chat). **Never redefine a kernel module locally — edit it in core.**
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

Each app loads **its own** `.env` from its package dir (`dotenv`); the repo-root `.env.example` is the
comprehensive reference, with minimal per-app `*.env.example` subsets. (Optionally keep one file by
symlinking each app's `.env` to a root `.env` — `ln -sf ../../.env apps/api/.env`; a local convenience,
gitignored, not shipped. See README → "Environment files".) `docker-compose.yml` lives at the repo root
and reads the root `.env` directly; each app image builds from the repo root context. **Every service is profile-gated, so a bare `docker compose up`
starts nothing.** The model is **two axes** (additive/OR). **Axis 1 — data plane + API (REQUIRED, pick
EXACTLY ONE, mutually exclusive):** `--profile supabase` (external Supabase Postgres + Storage) or
`--profile selfhost` (local `db` + `minio`); either brings up the API itself (`agora` + `proxy` + `cron`).
So the normal "just the API" deploy is `docker compose --profile supabase up` (or `--profile selfhost` for
self-contained). **Axis 2 — optional add-ons (compose freely on top of a data plane):** `--profile scorer`
(scorer ×3 + `neo4j`), `--profile secure-chat` (**Redis + `secure-chat`**), `--profile scale` (Redis as the
cross-replica rate-limit store), and `--profile full` = **all** optional add-ons (= scorer + secure-chat).
"Everything" is `--profile full --profile <supabase|selfhost>`.
`secure-chat` is its own E2E delivery process — like `agora` it does NOT bundle a DB; it persists
`secure_*` to whatever `DATABASE_URL` points at (v1 **shares the main Postgres** / Supabase, already
migrated). Because it **rides `full`**, a full deploy routes `/v7/:projectId/secure-chat/*` +
`/secure-socket/` to it through the Caddy front door automatically (set `REDIS_URL=redis://redis:6379`); a
**standalone/split secure-chat box** is `--profile secure-chat` alone, pointing `DATABASE_URL` at a remote
Postgres (no API). The **`proxy`** service is a **Caddy** front door (`deploy/proxy/`) — the single public
entrypoint that serves the admin SPA AND routes every service (auto-HTTPS + HSTS/headers + body cap +
authoritative `X-Forwarded-For`; one hop → set `RATE_LIMIT_TRUSTED_HOPS=1`; `SERVER_NAME=:80` for plain
HTTP behind your own TLS terminator). It rides the data-plane profiles (up whenever the API is) and
replaces the old admin nginx (now removed). The `selfhost` data plane runs the SAME api fully
self-contained (no Supabase cloud — the local `db` is still the `supabase/postgres` image, required for
the migrations' extensions + `auth` roles) — point `DATABASE_URL` at `db`, set `STORAGE_PROVIDER=s3` +
the `S3_*` block at `minio` (the Caddy front door serves public media at `/media`), and
`DEFAULT_AUTH_PROVIDER=native`. See `docs/SELF-HOSTING.md`.

**Storage is pluggable** (`lib/storage/` provider seam): `STORAGE_PROVIDER` picks `supabase` (default,
Supabase Storage) or `s3` (any S3-compatible store — MinIO/AWS). `lib/storage.ts`'s
`uploadBytes`/`publicUrl` delegate to `getStorage()`, so call sites + the `files` table (stores the
resolved URL in `original_path`) are backend-agnostic. The S3 provider creates the bucket +
public-read policy in-code on first upload (same posture as the Supabase public bucket — `SECURITY.md`).
Auth is likewise per-project (`projects.auth_provider` native|supabase, `getAuthProvider()`); OAuth is
Supabase-brokered (returns `oauth/not-configured` when unset).

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
  `storage.ts` (upload facade → the `storage/` provider seam: Supabase Storage or S3/MinIO, picked by
  `STORAGE_PROVIDER`), `supabase.ts` (lazy `getSupabase()`).
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

**Env:** `@agora/api` loads `apps/api/.env` (`dotenv`, resolved from `apps/api/`) — `cp .env.example .env`
there. (Optional: symlink it to a root `.env` to share one file across apps — gitignored; see README →
"Environment files".) `DATABASE_URL` is the Supabase
**transaction pooler (:6543)** and is the only hard requirement. The rest gate specific features and
are validated as optional: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_ANON_KEY`
(Auth + Storage), `VOYAGE_API_KEY` (semantic search), `RATE_LIMIT_MAX`/`RATE_LIMIT_AUTH_MAX` (edge
rate limiting, off unless set), `OPERATOR_USER_IDS`/`OPERATOR_EMAILS` (deployment-operator allowlist),
`NEO4J_URI`/`NEO4J_AUTH` (social graph — both scorer writes and API reads; unset →
scorer skips edge writes, `/social/*` endpoints return 503). Empty strings are treated as unset.

**Operators (deployment god-view).** `OPERATOR_USER_IDS`/`OPERATOR_EMAILS` (comma-separated profile
UUIDs / case-insensitive emails) are an env allowlist resolved by `lib/operators.ts` `isOperator()`.
The flag is stamped into the access JWT at mint time (`lib/tokens.ts`), read back in
`middleware/auth.ts`, and surfaces as **`c.var.auth.isOperator`** — so handlers get a project-wide
admin (all spaces/content/reports) with no extra DB hit. Independent of any space role; powers the
admin app and bypasses moderation-visibility filtering. Unset → no operators (everyone space-scoped).
The operator is the **platform-operator** (cross-tenant, the hosting provider); within-project god
power is now a separate DB grant (project owner/admin, below). The hierarchy is
`operator ⊇ owner ⊇ admin ⊇ steward ⊇ member` — an operator satisfies every within-project predicate,
so single-project deployments are unaffected.

**Project owners/admins (per-project god-view).** The within-project tier between member and the
platform-operator — a **DB-backed grant** in `project_roles` (`role ∈ owner|admin|steward`, migrations
`0044`/`0045`; the old `project_stewards` rows were backfilled to `role='steward'`, table retained but
deprecated). Resolved by `lib/project-roles.ts` `getProjectRoles()` (30s cache, mirrors
`lib/social-config.ts`) and folded into the access JWT at mint/refresh as `powner`/`padmin` claims
(`lib/tokens.ts`), read back in `middleware/auth.ts` as **`c.var.auth.isProjectOwner`/`isProjectAdmin`**
(effective on next token refresh, like the operator/steward flags). Guard helpers
`isProjectAdmin(a)` (= operator‖owner‖admin) / `isProjectOwner(a)` (= operator‖owner) +
throwing `requireProjectAdmin(c)`/`requireProjectOwner(c)`. **Every within-project gate that used to
read raw `isOperator` now uses these** (space access, moderation visibility, search, report scope +
`/reports/:id/resolve`, suspensions, project/feed/webhook/social config, dashboard scope +
`/admin/community/overview`, steward case access). **Deployment** powers stay raw `isOperator`
(`/admin/config`, the Supabase DB-size + server-resource cards). Grant
management is **`GET/POST/DELETE /v7/:projectId/roles`** (`routes/roles.ts`): viewing is
project-admin-gated, mutating is project-owner-gated; the last `owner` can't be revoked
(`roles/last-owner`). **Never write a within-project gate that checks `isProjectAdmin` but excludes
operator** — the helpers already fold it in.

**Stewards (conflict resolution).** A trust tier **between member and project-admin** powering the admin
**Steward** tab (a conflict-resolution caseload — distinct from moderation, which judges content).
A **DB-backed grant** now stored in `project_roles(role='steward')`; project owners grant community
members (`POST /steward/stewards`, owner-gated). Resolved by `lib/stewards.ts` `isSteward(projectId,
profileId)` (a thin delegate to `getProjectRoles`), stamped into the access JWT at mint/refresh
(`lib/tokens.ts`), read back in `middleware/auth.ts` as **`c.var.auth.isSteward`** (so a grant takes
effect on the user's next token refresh, like the operator flag). Privilege is **route-scoped** to
`routes/steward.ts` (gated `isProjectAdmin||isSteward` — project owners/admins reach the caseload too)
— stewards do NOT inherit the operator's global read bypass. A case escalation removes the subject content via the
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

## Diagnostics

**Secure-chat log correlator** (`apps/api/scripts/diag/secure-chat-log-normalize.mjs`). When secure
chat misbehaves, the two log streams — the **client SDK** console (`[secure-chat:LAYER] LEVEL → /…`
from `@agora-sdk/secure-chat-*` `debug.ts`) and the **API server** (`[ISO] LEVEL : request {json}`
from wonder-logger) — name the same operation with **different identifiers** (device-row churn) and
the client emits **no timestamps**, so they can't be eyeballed into alignment. This script lifts both
into one common event schema, auto-detecting each line's format (arg order is free; a single
interleaved file works), then prints a correlation report.

```bash
# Secure-chat now runs as @agora/secure-chat (its own process) — capture ITS stream. The diag script
# still lives under apps/api/scripts/diag. Build the kernel first (apps consume @agora/core's dist).
cd apps/secure-chat
# capture the server stream to a file first (the debug/trace logs live behind LOG_LEVEL):
LOG_LEVEL=trace pnpm dev 2>&1 | tee /tmp/agora-api.log     # then reproduce in the browser
# paste the browser console (Verbose on) into client.log, then correlate (diag script lives in api):
node ../api/scripts/diag/secure-chat-log-normalize.mjs client.log /tmp/agora-api.log   # human report
node ../api/scripts/diag/secure-chat-log-normalize.mjs --ndjson client.log /tmp/agora-api.log   # raw events
cat client.log /tmp/agora-api.log | node ../api/scripts/diag/secure-chat-log-normalize.mjs -    # stdin
```

The report answers the questions hand-reading can't: **device-row id overlap** (client set vs server
set → is this even one run, or churn?), **op reachability** (did every client REST request reach the
server, or die locally?), **realtime health** (`/secure` socket connect attempts vs errors vs
server-side connections), and **flags** (stale catch-up cursor on a fresh device, `available:0`
key-package counts). Worked fixtures live in `scripts/diag/fixtures/`. The server tier of the logs is
on at the default `LOG_LEVEL=debug`; use `trace` for the full firehose (per **Log with intent** +
`apps/secure-chat/src/routes/secure-chat.ts` / `apps/secure-chat/src/realtime/secure-socket.ts`). The longer-term plan (a shared `traceparent`
correlation id + the `chat-diag` harness emitting this schema natively) is `docs/SECURE-CHAT-DIAG-HARNESS.md`.

## Database migrations (Drizzle)

Schema lives in `apps/api/src/db/schema/*.ts`, the single source of truth for tables. To change it:
edit `schema/*.ts` → `pnpm db:generate` (drizzle-kit emits the table DDL) → `pnpm db:migrate:run`.
Anything Drizzle can't express (triggers, functions, RLS, PostGIS, RPC) is a **hand-written custom
migration** in `apps/api/drizzle/`, applied in journal order and written **idempotently** (`create
… if not exists`, `create or replace`, `drop trigger if exists` before create).

**The per-migration history is NOT mirrored here** — read `apps/api/drizzle/` (each file's header)
and `CHANGELOG.md` for what each migration did. Only the non-obvious conventions live here:

- **Apply with `db:migrate:run`, not `db:migrate`** — drizzle-kit's journal schema is misconfigured;
  `db:migrate:run` is the runtime migrator the container uses (journal lives in the `drizzle` schema).
- **Some columns are deliberately kept out of the TS schema** and exist only in custom SQL — PostGIS
  `geography` columns + their indexes (`0001`), and the scorer's `moderation_analyses.source_msg_id`
  dedup column (`0028`). Don't "fix" the Drizzle schema to add them.
- **RLS enablement is one-time** (the `0017` dynamic guard enables deny-all on every *existing* base
  table). A brand-new table is **not** covered retroactively — it must ship its own explicit RLS
  deny-all in the migration that creates it (see `auth_credentials`/`auth_email_tokens`, and
  `project_roles` in `0045`).
- **Read-path visibility lives in SQL** for recursive/semantic reads: `fetch_comment_thread(…,
  p_hide_removed)` and `match_content(…, p_viewer, p_privileged, p_hide_removed)` (`0019`). New
  recursive/search reads over moderatable content go through these, not raw queries.

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
- **Observability (OTel):** every service is instrumented — `src/instrument.ts` (the **first** import in
  `index.ts`, before http/db load) starts traces + metrics from `wonder-logger.yaml` in BOTH `@agora/api`
  and `@agora/secure-chat` (the latter loads the shared core YAML via `@agora/core/lib/wonder-logger-config`
  and sets `SERVICE_NAME=agora-secure-chat`); the Python scorer bootstraps in `scorer/telemetry.py`. Custom
  ops instruments live in `apps/api/src/lib/telemetry.ts` (embeddings/moderation/feed/socket.io —
  no-op-safe, never guard them). Two metrics worlds, kept separate: `lib/metrics.ts`/`api_usage` is
  per-project **product** metering (admin dashboard); OTel is the **ops** layer (service-level RED + the
  custom instruments, Prometheus `:9464` + OTLP, no `project_id` label). Collection is the bundled
  `--profile observability` stack (Alloy → Tempo/Mimir/Loki/Grafana, `deploy/observability/`); endpoints
  default to `alloy`, `OTEL_SDK_DISABLED=false` is the single on-switch. `docs/TELEMETRY.md` is the guide.

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
- ✅ **Storage**: `storage.ts` — POST `/storage` (multipart → the configured backend's `agora` bucket →
  `files` row), POST `/storage/images` (sharp → webp original + thumbnail/small/medium variants).
  Backend is pluggable via the `lib/storage/` seam (`STORAGE_PROVIDER` = `supabase` | `s3`).
- ✅ **Misc**: `misc.ts` — `/oauth/identities` (list/delete), `/projects/lean`, `/utils/get-metadata`
  (OG/link preview, SSRF-guarded). Only `crypto/sign-testing-jwt` remains a stub (dev convenience).
- **REST surface is complete** and the backend is feature-complete.
- ✅ **RLS**: deny-all backstop on all tables + public-read (`0008`) + `authenticated` self-access
  reads + enablement guard (`0017`). Server bypasses RLS (the trust boundary); RLS is defense-in-depth.
- ✅ **Client SDK forked + repointed** — `../agora-sdk` (`@agora-sdk/*`), base URL repointed off
  `api.replyke.com` (MANIFEST §0), exercised 1:1 by the `../agora-demo` harness (see **Ecosystem**).
- ✅ **Social graph (optional · Neo4j)** — Garden complete: Weather, Constellation (GDS Louvain,
  k-anon), Neighborhood (dyadic brightness, FRICTION-dimming). Operator analytics tier:
  `/admin/social/influence`, `/admin/social/silos`, `/admin/social/engagement` + React dashboards.
  All surfaces env-gated behind `NEO4J_URI`; config-gated per-project via `projects.social_config`.
- **Known server gaps (minor):** `@mention` resolution is unimplemented — mention tokens are stored
  in jsonb and fan-out notifications fire, but no link-resolution or validation endpoint exists.
  RLS write policies are not set (server is the trust boundary; accepted per `SECURITY.md`).
  E2E integration tests for real Supabase auth/Storage/Voyage/Anthropic are opt-in (need live
  creds, skipped in CI — all three surfaces are covered by the unit + mock-integration suites).

`apps/api/src/routes/entities.ts` is the reference for a fully-built domain router.

License: **AGPL-3.0-only** for the server (`@agora/api`/`admin` + `services/*`, e.g. `services/scorer`);
`@agora-server/contract` stays **Apache-2.0** as the permissive wire-contract surface the SDK builds on.
Contributions are DCO-signed (`git commit -s`), no CLA. Community edition is AGPL-3.0 forever.
