# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agora is a self-hosted, **Replyke-API-compatible** community/social backend. Goal: an API the
(forked) Replyke SDK consumes **1:1**, so the SDK's typed hooks work unchanged against your own
server. **The contract is the constraint** — match `docs/MANIFEST.md` (REST paths, envelopes,
socket.io events) and `docs/MODELS.md` (response shapes) exactly, or the SDK's typed hooks break.

## Architecture

```
client + forked Replyke SDK
   │  HTTPS  /v7/:projectId/<domain>/...        (+ socket.io for chat — not yet built)
   ▼
@agora/server  (Hono)   endpoints + business logic + permission checks
   │  Drizzle ORM (postgres.js, Supabase transaction pooler :6543, prepare:false)
   ▼
Supabase Postgres   schema + triggers + RPC + pgvector + PostGIS
        └── @supabase/supabase-js is reserved for Auth + Storage ONLY (lazy getSupabase())
```

- **Drizzle owns all DB access** via a direct `postgres.js` connection (`server/src/db/index.ts`).
  The Supabase JS client is *only* for Auth/Storage and is lazily constructed.
- **`auth.users` is NOT modeled in Drizzle** — `profiles.auth_user_id` is a plain uuid the app
  links, so Drizzle never tries to own the Supabase-managed `auth` schema.
- Multi-tenant by `project_id` (every table has it; the SDK addresses `/v7/:projectId/...`).
  A single-project deployment just has one `projects` row.

## Layout

- `docs/MANIFEST.md` — **the contract**: every REST endpoint (method+path, ✅SDK-confirmed vs
  🔶inferred), socket.io event names, auth/pagination/error envelopes, SDK fork points.
- `docs/MODELS.md` — field-level response shapes (source of truth for API output + schema).
- `server/src/db/schema/*.ts` — Drizzle schema, the **single source of truth** for the DB.
- `server/drizzle/` — generated + custom SQL migrations (see DB section).
- `server/src/lib/shape.ts` — row → camelCase API model shapers + batchers (`attachUserReactions`,
  `loadUsers`); `lib/validation.ts` — zod schemas + `parseBody()`.
- `server/src/http/` — `envelope.ts` (`paginate`/`readPagination`), `errors.ts` (`ApiError`/`Errors`), `context.ts`.
- `server/src/middleware/` — `project.ts` (resolves `:projectId`), `auth.ts` (verifies JWT).
- `server/src/routes/` — one router per domain; `realtime/socket.ts` — socket.io (stub).

## Commands

```bash
cd server
npm run dev          # tsx watch -> http://localhost:4000/v7  (loads .env via dotenv)
npm run typecheck    # tsc --noEmit — ALWAYS run before considering work done
npm run build        # tsc -> dist/

npm run db:generate  # after editing src/db/schema/*.ts -> new migration in drizzle/
npm run db:migrate   # apply migrations (idempotent: journal skips applied; safe to re-run)

# Validate triggers/RPC + (re)seed dev data; asserts loudly on failure:
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seed.sql
```

**Env:** the root `.env` is the single source (direnv `dotenv`), symlinked to `server/.env` so
dotenv resolves from `server/`. `DATABASE_URL` is the Supabase **transaction pooler (:6543)**.
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are optional until Auth/Storage handlers exist.

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

Schema lives in `server/src/db/schema/*.ts`. `drizzle-kit generate` produces table DDL; anything
Drizzle can't express is a **hand-written custom migration** in `server/drizzle/`, applied in
journal order and written **idempotently** (`create extension if not exists`, `create or replace`,
`drop trigger if exists` before create):

- `0000_init` — extensions (vector/postgis/pgcrypto, prepended) + enums + tables + btree indexes
- `0001_postgis` — `geography(Point,4326)` columns + GIN/GiST/IVFFlat indexes (kept out of TS schema)
- `0002_triggers` — denormalized counts + reputation
- `0003_functions` — `toggle_reaction`, `hot_score`/`refresh_entity_score`, `fetch_comment_thread`, `match_entities`
- `0004_rls` — enable RLS (deny-all backstop; no policies yet)

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
- **Auth:** `requireAuth`/`optionalAuth` only *verify* tokens. Token minting + refresh
  rotation/reuse-detection/30s-grace is the unbuilt auth service (MANIFEST §1).
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
- 🚧 **Stubbed** (`Errors.notImplemented`): `search` (embeddings), `storage` (Supabase Storage),
  `misc` (oauth/projects/utils).
- ⬜ RLS policies (only enablement done); fork + repoint `@replyke/core` base URL (MANIFEST §0).

`server/src/routes/entities.ts` is the reference for a fully-built domain router.

License: Apache-2.0 (matching Replyke).
