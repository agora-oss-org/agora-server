# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agora is a self-hosted, **Replyke-API-compatible** community/social backend. Goal: an API the
(forked) Replyke SDK consumes **1:1**, so the SDK's typed hooks work unchanged against your own
server. **The contract is the constraint** — match `docs/MANIFEST.md` (REST paths, envelopes,
socket.io events) and `docs/MODELS.md` (response shapes) exactly, or the SDK's typed hooks break.

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

pnpm workspaces (corepack-pinned `pnpm@10.14.0`). Three packages:

- `apps/api` — `@agora/api`, the Hono backend (everything below; the reference package).
- `apps/admin` — `@agora/admin`, a Vite + React + TS admin frontend that consumes the API.
- `packages/contract` — `@agora/contract`, the **shared API contract**: response-model TS types
  (`User`/`Entity`/`Comment`/`AuthUser`/`AuthContext`), the reaction taxonomy, the pagination
  envelope + `paginate()`, the error-envelope shape, and the 39 zod request schemas. Pure types +
  zod, **no hono/drizzle**. Built to `dist/` and consumed via its `exports` map by both api + admin.

**Rule:** any API request/response type or zod schema shared between server and admin lives in
`packages/contract` (built first; `pnpm -r build` orders it). `apps/api`'s `shape.ts` /
`validation.ts` / `envelope.ts` / `context.ts` re-export the contract symbols so existing call sites
are unchanged — never redefine a contract type locally (that reintroduces drift).

Root `.env` is the single source (direnv `dotenv`), symlinked from `apps/api/.env -> ../../.env`.
`docker-compose.yml` lives at the repo root; the api image builds from the repo root context.

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
demo user (`node scripts/seed-demo-user.mjs` → `agora-demo@gmail.com` / `DemoPass123!`), then run the
demo (`cd ../agora-demo && npm run dev` → `:5173`, points at the server via `VITE_API_BASE_URL`).
Project id is the seed UUID `11111111-1111-1111-1111-111111111111`.

## Layout

- `docs/MANIFEST.md` — **the contract**: every REST endpoint (method+path, ✅SDK-confirmed vs
  🔶inferred), socket.io event names, auth/pagination/error envelopes, SDK fork points.
- `docs/MODELS.md` — field-level response shapes (source of truth for API output + schema).
- `packages/contract/src/*.ts` — shared types + zod schemas (`@agora/contract`); 1:1 with the docs above.
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

## Commands

```bash
# pnpm workspaces via corepack — `corepack enable` once. From the repo root:
pnpm install                 # install all workspaces
pnpm -r build                # build every package (contract first, topologically)
pnpm -r typecheck            # ALWAYS run before considering work done
pnpm --filter @agora/contract build   # rebuild the shared contract after editing it

cd apps/api                  # the backend lives here
pnpm dev             # tsx watch -> http://localhost:4000/v7  (loads .env via dotenv)
pnpm typecheck       # tsc --noEmit — ALWAYS run before considering work done
pnpm build           # tsc -> dist/

pnpm db:generate     # after editing src/db/schema/*.ts -> new migration in drizzle/
pnpm db:migrate      # apply migrations (idempotent: journal skips applied; safe to re-run)

# Validate triggers/RPC + (re)seed dev data; asserts loudly on failure (run from apps/api):
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seed.sql
```

> ⚠️ `@agora/api` depends on `@agora/contract`'s built `dist/` (consumed via its `exports` map), so
> run `pnpm --filter @agora/contract build` (or `pnpm -r build`) before typechecking the api from a
> clean checkout.

**Env:** the root `.env` is the single source (direnv `dotenv`), symlinked from
`apps/api/.env -> ../../.env` so dotenv resolves from `apps/api/`. `DATABASE_URL` is the Supabase
**transaction pooler (:6543)** and
is the only hard requirement. The rest gate specific features and are validated as optional:
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_ANON_KEY` (Auth + Storage),
`VOYAGE_API_KEY` (semantic search). Empty strings are treated as unset.

**Mint a test JWT** (for authed routes; HS256 over `ACCESS_TOKEN_SECRET`, `sub`=userId):
```bash
SECRET=$(grep -E '^ACCESS_TOKEN_SECRET=' .env | cut -d= -f2-)
TOK=$(SECRET="$SECRET" node --input-type=module -e 'import {SignJWT} from "jose"; \
  process.stdout.write(await new SignJWT({role:"visitor"}).setProtectedHeader({alg:"HS256"}) \
  .setSubject("<USER_UUID>").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SECRET)))')
```
⚠️ Do NOT load the secret via `dotenv` inside a `$(...)` — its stdout banner (`◇ injected env…`,
non-ASCII) corrupts the value and yields an invalid HTTP header (400 before Hono). `grep` it.

## Database migrations (Drizzle)

Schema lives in `apps/api/src/db/schema/*.ts`. `drizzle-kit generate` produces table DDL; anything
Drizzle can't express is a **hand-written custom migration** in `server/drizzle/`, applied in
journal order and written **idempotently** (`create extension if not exists`, `create or replace`,
`drop trigger if exists` before create):

- `0000_init` — extensions (vector/postgis/pgcrypto, prepended) + enums + tables + btree indexes
- `0001_postgis` — `geography(Point,4326)` columns + GIN/GiST/IVFFlat indexes (kept out of TS schema)
- `0002_triggers` — denormalized counts + reputation
- `0003_functions` — `toggle_reaction`, `hot_score`/`refresh_entity_score`, `fetch_comment_thread`, `match_entities`
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

To change schema: edit `src/db/schema/*.ts` → `db:generate` → `db:migrate`. Edit triggers/functions/
RLS/PostGIS by hand in their custom migration files.

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
- **Auth:** `requireAuth`/`optionalAuth` only *verify* tokens; minting + refresh
  rotation/reuse-detection/30s-grace live in `lib/tokens.ts` (`refresh_tokens` table).
  Identity is backed by Supabase Auth via the lazy anon client.
- **Realtime is socket.io** — event names in `realtime/socket.ts` must stay byte-identical to
  `@replyke/core/types/socket.ts`; REST handlers fan out via `emitToConversation()` after writing.

## Status

- ✅ **Foundation validated on cloud Supabase**: migrations applied + idempotent; triggers/RPC
  asserted by `scripts/seed.sql`; end-to-end HTTP verified.
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

`apps/api/src/routes/entities.ts` is the reference for a fully-built domain router.

License: Apache-2.0 (matching Replyke).
