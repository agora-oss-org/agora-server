# Agora

Self-hosted, **Replyke-API-compatible** community/social backend on **Supabase**. Goal: an
API that the (forked) Replyke SDK consumes **1:1** — so the SDK's typed hooks work unchanged
against your own server. The contract is the constraint; match it exactly.

## Architecture (Pattern 2: custom server in front of Supabase)

```
client + forked Replyke SDK
   │  HTTPS  /v7/:projectId/...        (+ socket.io for chat)
   ▼
@agora/server (Hono)  ← endpoints + business logic + permission checks
   │  service-role key (bypasses RLS — this server IS the trust boundary)
   ▼
Supabase: Postgres (schema + triggers + RPC + pgvector) · Auth · Storage · Realtime
```

## Layout

- `docs/MANIFEST.md` — **the contract**. REST endpoints (method+path, ✅SDK-confirmed vs
  🔶inferred), socket.io event names, auth/pagination/error envelopes, SDK fork points.
- `docs/MODELS.md` — field-level response shapes (source of truth for both API output and schema).
- `db/migrations/0001–0008` — schema, triggers, RPC, RLS. Apply **in order**.
- `server/src/` — `index.ts` (entrypoint) · `lib/` (env, supabase client) · `http/`
  (envelopes, errors, context types) · `middleware/` (project resolution, JWT) · `routes/`
  (one router per domain) · `realtime/socket.ts` (socket.io).

## Commands

```bash
# server (cd server first)
npm run dev          # tsx watch, http://localhost:4000/v7
npm run typecheck    # tsc --noEmit — run before considering work done
npm run build        # tsc -> dist/

# database
for f in db/migrations/0*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

## Conventions & invariants (don't break these)

- **URL shape is fixed:** every route is `/v7/:projectId/<domain>/...`. `projectId` is the
  first segment after `/v7` and is resolved by `middleware/project.ts`.
- **Response envelopes are part of the contract.** Lists use `{ data, pagination }` via
  `http/envelope.ts` (`paginate()` / `readPagination()`). Errors use `{ error, code, field? }`
  via `http/errors.ts` (`ApiError` / `Errors.*`) — always throw these, never bare strings.
  Caveat: the **connections** module uses a *different* pagination shape (see MANIFEST §1/§3).
- **Response objects must match `@replyke/core` interfaces exactly** (camelCase, all fields)
  or the SDK's typed hooks break. Check `docs/MODELS.md` before shaping a row. DB rows are
  snake_case → map to camelCase at the route boundary.
- **Denormalized counts are trigger-maintained — never recompute per request.**
  `reaction_counts`, `replies_count`, `members_count`, `thread_reply_count`, `entity_count`,
  reputation. Mutate via the normalized tables / RPC; let `0006_triggers.sql` keep counts current.
- **Reactions go through `toggle_reaction` RPC** (atomic set/switch/clear). After entity vote
  changes, call `refresh_entity_score`.
- **v6 + v7 reactions coexist**: keep both legacy `upvotes[]`/`downvotes[]` arrays and v7
  `reaction_counts` on entities/comments — the SDK types expose both.
- **Server uses the service-role key** (`lib/supabase.ts`) and is the trust boundary. RLS is
  on as defense-in-depth only. Enforce ownership/roles in handlers, not via RLS.
- **Auth:** `middleware/auth.ts` only *verifies* Agora-issued access tokens. Token *minting* +
  refresh rotation/reuse-detection/30s-grace is the hard part (not yet built — see MANIFEST §1).
- **Realtime is socket.io, not raw ws / Supabase Realtime.** Event names in
  `realtime/socket.ts` must stay byte-identical to `@replyke/core/types/socket.ts`. REST
  handlers fan out durable events via `emitToConversation()` after writing to Postgres.

## Status

Manifest ✅, schema ✅, server scaffold ✅ (routes wired, handlers are `Errors.notImplemented`
stubs, typechecks & boots). **Next:** implement handlers (entities → comments → auth first;
chat realtime last), then fork `@replyke/core` and repoint the hardcoded base URL (MANIFEST §0).
`server/src/routes/entities.ts` `GET /:id` is the reference pattern for a real handler.

License: Apache-2.0 (matching Replyke).
