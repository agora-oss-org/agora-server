# Changelog

All notable changes to Agora are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Request-metering middleware (`api_usage` table, migration `0016`).** A Hono middleware on the
  `/v7` group times every project-scoped request and accumulates per-(project, month) counters in
  memory — requests, client-egress bytes (response `Content-Length`), total duration, errors —
  flushed every 10s to `api_usage` via an additive upsert (concurrent replicas sum safely; ≤10s of
  counts lost on crash). Powers the dashboard "App metering" cards (API Calls / Client Egress / Avg
  Response Time). Migration is **hand-written** (idempotent) because `db:generate` is currently
  blocked by a meta snapshot collision (0011/0012) — run `pnpm db:migrate` to apply.
- **Admin app — shell + Moderation.** `@agora/admin` grew from a skeleton into a real role-aware SPA:
  Tailwind v4 dark theme + Radix primitives, react-router routing, TanStack Query data layer, an
  authed API client (token storage + single-flight refresh-on-401), email/password login, and a
  sidebar/topbar layout. The first live section is **Moderation** — an Open/Resolved reports inbox
  (`/reports/pending` + `/reports/moderated`) with a review dialog that fetches the reported content
  and lets a moderator **remove / keep / dismiss** (space-scoped moderation + report resolution).
  The UI adapts to `isOperator` (project-wide vs space-scoped). Dashboard + Settings are stubbed next.
- **Deployment-operator gate for the admin app.** Env allowlist `OPERATOR_USER_IDS` (profile UUIDs)
  and/or `OPERATOR_EMAILS` (comma-separated) marks an identity as a deployment operator. On sign-in
  the API stamps an `operator` claim into the access JWT and exposes `AuthUser.isOperator`; handlers
  read `c.var.auth.isOperator` with no extra DB hit (re-derived on refresh-token rotation).
- **`GET /reports/pending`** — the moderation inbox: open (unresolved) reports, newest first,
  paginated. **Role-scoped:** operators see every report in the project; everyone else sees only
  reports filed against spaces they own or moderate. The same scoping is now applied to
  `GET /reports/moderated` (previously project-wide regardless of role — a leak for non-operators).
- **`agora-admin` Docker image** — `apps/admin/Dockerfile` builds the admin SPA and serves it on
  nginx, reverse-proxying `/v7` + `/socket.io` to the API (same origin → no CORS; upstream set via
  `API_UPSTREAM`, default `http://agora:4000`, lazily DNS-resolved so it boots before the API does).
  Added an `admin` service to `docker-compose.yml` (`${ADMIN_PORT:-8080}:80`), and the publish
  workflow is now a matrix that builds both `agora-api` and `agora-admin` (GHCR + Docker Hub).

## [0.3.0] - 2026-05-28

### Added
- **`@agora/contract`** — a shared workspace package holding the API contract: response-model TS
  types (`User`/`Entity`/`Comment`/`AuthUser`/`AuthContext`), the reaction taxonomy, the pagination
  envelope + `paginate()`, the error-envelope shape, and the 39 zod request schemas. Pure types +
  zod (no hono/drizzle), consumed 1:1 by the backend and the new admin frontend.
- **`@agora/admin`** — a Vite + React + TS admin frontend skeleton that consumes `@agora/contract`.
- **Supercronic scheduler sidecar** (`Dockerfile.cron` + `crontab` + a `cron` service in
  `docker-compose.yml`) — fires the secret-gated `/internal/cron/{digests,recompute-scores}`
  endpoints over the internal network (hourly digests; 15-min score recompute). Kept separate from
  the app image so scheduling never double-fires across API replicas. Requires `CRON_SECRET` in
  `.env`. supercronic `v0.2.46`, pinned by SHA256 (amd64 + arm64).

### Changed
- **Monorepo restructure (pnpm workspaces).** The backend moved from `server/` to `apps/api/` and
  the package was renamed `@agora/server` → **`@agora/api`**. Tooling switched from npm to pnpm
  (corepack-pinned `pnpm@10.14.0`); the repo root now hosts `package.json`, `pnpm-workspace.yaml`,
  and a shared `tsconfig.base.json`. The backend's `shape.ts` / `validation.ts` / `envelope.ts` /
  `context.ts` now re-export their shared symbols from `@agora/contract` (no behavior change).
- **Docker/CI.** The api image now builds from the **repo root** context (it depends on the
  `@agora/contract` workspace package) via `pnpm deploy`; `docker-compose.yml` moved to the repo
  root; the publish workflow targets `apps/api/Dockerfile`. The root `.env` symlink is now
  `apps/api/.env -> ../../.env`. The published image was renamed `agora` → **`agora-api`**
  (`ghcr.io/<owner>/agora-api`, `docker.io/agoraserver/agora-api`).

### Fixed
- **`POST /auth/sign-out` no longer 401s on a stale session.** It was `requireAuth`, so an expired
  access token (the common case when signing out a long-idle tab) returned `401` before it could
  revoke anything — surfacing as a red "Server sign-out failed" error even though the SDK then
  cleared the local session anyway. Sign-out is now `optionalAuth` and **idempotent**: it revokes the
  refresh token the SDK sends in the body (works with no/expired access token), falls back to
  revoking all of the authed user's tokens when only a valid access token is present, and always
  returns `200` (nothing to revoke is still a successful sign-out).

## [0.2.3] - 2026-05-27

Makes space chat usable for all space members, plus README launch polish.

### Added
- **README launch polish** — centered `assets/agora.png` logo + title, status/license/Supabase
  badges, and a prominent "Try it live" callout + badge linking the public demo at
  [demo.agora-oss.org](https://demo.agora-oss.org).

### Changed
- **Space chat is now a usable community channel.** `GET /chat/spaces/:spaceId/conversation`
  (get-or-create) now requires the caller to be the space **owner or an active space member**, and
  **auto-joins them** to the conversation on fetch. Previously only the conversation's creator was a
  member, so every other space member received the conversation object but then `403`'d on
  reading/posting (membership-gated) — making space chat effectively creator-only. New space
  conversations also seed `postingPermission` from the space (admins-only spaces ⇒ admins-only chat;
  already enforced on send), and the response now includes `currentMember` + `memberCount`. The demo
  surfaces it as a "💬 Space chat" panel in `SpaceView` (`useFetchSpaceConversation` +
  `ConversationProvider`).

## [0.2.2] - 2026-05-27

Fixes semantic search returning no results, plus destructive-reset and sample-post dev tooling.

### Added
- **`scripts/wipe.mjs` (`npm run db:wipe`)** — destructive dev reset that clears the backend to a
  clean slate: TRUNCATEs all public tables (RESTART IDENTITY CASCADE; `projects` +
  `project_integrations` preserved unless `--include-projects`), deletes all Supabase Auth users
  (admin API), and empties the `agora` Storage bucket. Dry-run by default; requires `--yes` to
  execute, with a typed project-ref confirmation in a TTY (`--force` for CI). Per-store toggles
  (`--no-data`/`--no-auth`/`--no-storage`).
- **Sample image-post seeders** — `scripts/seed-{miso,lasagna,ribs}-post.mjs`
  (`npm run seed:miso` / `seed:lasagna` / `seed:ribs`) seed sample posts owned by the demo user,
  uploaded through the real entity pipeline (multipart → sharp variants → Storage → `files` row).
  Each skips if its post already exists; configurable via `API_BASE_URL`/`PROJECT_ID` and a per-post
  image-URL env (`MISO_IMAGE_URL` / `LASAGNA_IMAGE_URL` / `RIBS_IMAGE_URL`).

### Fixed
- **Semantic content search returned nothing (`200 []`).** The `content_embeddings` (and legacy
  `entity_embeddings`) vector index was **IVFFlat** (`lists=100`), an approximate index that probes
  only `ivfflat.probes` (default 1) of its lists per query. On a small/young dataset nearly every
  query probed an empty list, so `match_content`'s `ORDER BY embedding <=> query LIMIT n` came back
  empty even though relevant rows existed (the route worked; it just matched nothing). Migration
  `0015_embeddings_hnsw` replaces both IVFFlat indexes with **HNSW** (pgvector ≥ 0.5; no training
  step, no empty-list failure, strong recall from the first embedding). Index-only change — no data
  touched.

## [0.2.1] - 2026-05-27

Fixes OAuth social login behind a TLS-terminating reverse proxy.

### Added
- **`PUBLIC_BASE_URL` env var** — the server's public origin (scheme + host) used to build absolute
  OAuth callback URLs. Resolution order in `startOAuth` (`routes/misc.ts`): `PUBLIC_BASE_URL` →
  `X-Forwarded-Proto`/`X-Forwarded-Host` → raw request origin. Documented in `README.md` (new "OAuth
  providers (Supabase Redirect URLs)" section) and `.env.example`.

### Fixed
- **OAuth `redirect_to` used the internal origin behind a reverse proxy.** `startOAuth` built the
  callback from `new URL(c.req.url).origin`, which behind a TLS-terminating proxy is the internal
  `http://<internal-host>` — wrong scheme *and* host. Supabase couldn't match it against the Redirect
  URLs allowlist and silently fell back to the project's Site URL (browser landed on `…/?code=…` with
  no token fragment, so social login dead-ended). The callback origin now resolves via
  `PUBLIC_BASE_URL` → forwarded headers → request origin. Local/dev (no proxy) is unchanged.

### Notes
- Supabase's **Redirect URLs** allowlist must permit the *server's* public callback
  (`<public-origin>/v7/*/oauth/callback**`), not the front-end app's origin. The trailing `**` is
  **required**: Supabase matches the full `redirect_to` including the `?aid=<state>` query the server
  appends, so a bare `…/oauth/callback` never matches.

## [0.2.0] - 2026-05-27

A configurable feed-ranking system, file uploads on entities and chat, and a batch of
SDK-contract fixes found while building the demo client.

### Added
- **Flexible, configurable feed ranking.** A closed algorithm registry (`lib/ranking.ts`) adds
  `decay` (true exponential half-life), `gravity` (HN), `wilson` (confidence lower bound), and
  `bayesian` (shrunk mean) alongside the existing `hot`/`top`/`new`/`controversial`. `GET /entities`
  takes optional `rankParams` (JSON scalar of numeric tunables — half-life/gravity/z/C/m, validated +
  clamped), `rankAnchor` (pins the decay clock for stable pagination; echoed back in the response),
  and `rerank` (opt-in webhook). Precedence: request `rankParams` > per-project `feed_config` >
  built-in defaults. All ORDER BY lists are tie-broken `(createdAt, id)`. No algorithm name/weight is
  ever injected as SQL — names are a fixed enum, tunables are numeric.
- **Per-project `feed_config` + admin settings endpoint.** New `projects.feed_config` jsonb
  (migration `0013`) holding `{ defaultAlgorithm, decayMode, halfLifeHours, gravity, reactionWeights,
  diversity, rerankWebhook }`. Admin-gated `GET`/`PATCH /settings/feed` (project-admin only; PATCH
  deep-merges, re-rank secret redacted on read) backs the "Feed" settings UI. Resolved with a 30s
  cache (`lib/feed-config.ts`).
- **Stored-mode decay recompute + cron.** `recompute_decay_scores()` (migration `0014`) snapshots the
  evaluated half-life score into `entities.score` so `decay` projects with `decayMode:"stored"` stay
  index-served; `lib/recompute.ts` orchestrates per-project (decay-stored → decay fn, else hot_score).
  Secret-gated `POST /internal/cron/recompute-scores` (mirrors the digests cron) +
  `scripts/recompute-scores.mjs` (now feed_config-aware).
- **Feed re-rank webhook (escape hatch).** When `feed_config.rerankWebhook` is set and `?rerank=true`,
  the server over-fetches a candidate pool, POSTs it (HMAC-signed) to the host app, and applies the
  returned ordering — **fail-open** to the algorithm order on timeout/non-2xx/bad-signature
  (`lib/rerank.ts`).
- **`POST /chat/conversations/:id/messages` accepts file uploads (multipart).** The SDK's
  `useSendMessage` sends `multipart/form-data` with `files` when attachments are present; the handler
  now branches on Content-Type, uploads each file via the shared pipeline (`storeUpload` →
  images get sharp variants, other types stored as-is), links each `files` row to the message, and
  returns/emits the message with `files` populated. File-only messages (no text/gif) are allowed.
  `GET …/messages` batch-loads files (`loadMessageFiles`) so attachments render on reload. New
  generic `storeFileFromUpload` + `storeUpload` dispatcher in `lib/images.ts`.
- **`POST /entities` accepts image uploads (multipart).** The SDK's `useCreateEntity` switches to
  `multipart/form-data` with `images.files` when images are attached; the handler now branches on
  Content-Type, parses the form fields, runs each image through the shared `lib/images.ts` pipeline
  (sharp → variants → Supabase Storage → `files` row linked to the new entity), and returns the
  entity with its `files` populated. Entities also now carry their `files` on the feed list and
  single GET (batched via `loadEntityFiles`), so uploaded images render on reload and in the feed.
  The image-processing core was extracted from `POST /storage/images` into `lib/images.ts`
  (`storeImageFromUpload`) and is shared by both routes.
- **New accounts get a default username.** `ensureProfile` (the lazy profile-creation chokepoint
  for sign-up + first sign-in) now derives a username from the email local-part (`+tag` dropped,
  sanitized to `[a-z0-9_-]`) when none is supplied, instead of leaving it `NULL`. Collisions against
  the `(project_id, username)` unique constraint are avoided by suffixing with the auth user's id
  prefix (e.g. `jenova-marie` → `jenova-marie-2baf48ac`). Previously every email/password signup was
  nameless, so SDK/UI fell back to a raw id slice. Existing profiles are not backfilled.
- **`CHANGELOG.md`** (Keep a Changelog) + a keep-current rule in `CLAUDE.md`.

### Changed
- Docker images are now published to Docker Hub (`agoraserver/agora`) in addition to
  GHCR (`ghcr.io/jenova-marie/agora`).
- **Feed `top` now ranks by pure weighted-net votes (no time term)**, distinct from `hot` (which
  combines recency + votes). Previously `top` aliased the time-anchored `hot_score`, so `hot` and
  `top` were identical. Pair `top` with a `timeFrame` filter for "top this week/month".
- **Creating a subspace requires admin/owner of the parent.** `POST /spaces` with a `parentSpaceId`
  now runs `requireSpaceRole(parent, ["admin"])` (owner counts as admin); regular members get
  `403 spaces/insufficient-role`. Previously any authenticated user could nest a space under any
  parent.

### Fixed
- **Feed `sortBy` is no longer overridden by the SDK's default `sortByReaction`.** `buildFeedOrder`
  treated any `sortByReaction` as a sort override, but the SDK tags every feed request with a default
  `sortByReaction=upvote` — so every `sortBy` algorithm collapsed to "order by upvote count" (made all
  algorithms appear identical). A recognized algorithm (or `metadata.*`) in `sortBy` now wins;
  `sortByReaction` applies only as a fallback when no algorithm is chosen.
- **`GET /spaces/:id/membership/me` permissions respect membership status.** Any existing
  membership row (including a `pending` join request) returned `canRead: true`, so a not-yet-approved
  requester to a members-only space appeared able to read/act. Now `canRead`/`canPost`/`canModerate`
  require an **active** membership (pending/rejected/banned get only what `readingPermission`/
  `postingPermission` grant the public), and `canPost` honors `postingPermission: "admins"`.
- **`GET /spaces/:id/members` now honors the `status` and `role` query filters.** The handler
  ignored them and always returned every member, so the SDK's `useFetchSpaceMembers({ status:
  "pending" })` (join-request queue for private spaces) surfaced active members too. Both filters are
  now applied when present.
- **Connection routes reject non-UUID path params with 400 instead of crashing.** A username (or
  any non-UUID) in `:userId`/`:id` on the `/users/:userId/connection*` and `/connections/:id/*`
  endpoints reached a uuid-typed query and threw `invalid input syntax for type uuid` → an unhandled
  500. The params are now validated up front (`uuidParam`) and return
  `400 { code: "connections/invalid-id" }`.
- **Chat messages no longer render as duplicates.** `POST /chat/conversations/:id/messages` now
  accepts an optional `localId` and echoes it back in both the HTTP response and the `message:created`
  socket event. The SDK sends `localId` to reconcile its optimistic placeholder; without it echoed,
  the confirmed message couldn't replace the placeholder and both rendered. (`sendMessageSchema` +
  `shapeChatMessage` updated; `localId` is transient and not persisted.)
- **Token refresh now returns the user.** `POST /auth/request-new-access-token` returned only
  `{ accessToken, refreshToken }`, but the SDK's refresh/session-restore path calls
  `setUser(result.user)` — so every refresh wiped the current user from the store (breaking
  "is this my message?" checks and optimistic-message authorship). It now returns the `AuthUser`
  alongside the rotated tokens (`rotateRefreshToken` surfaces the `profileId`).
- **Chat list endpoints now match the SDK's cursor contract.** `GET /chat/conversations` and
  `GET /chat/conversations/:id/messages` returned the standard `{ data, pagination }` page/offset
  envelope, but the SDK's `useConversations`/`useChatMessages` expect `{ conversations, hasMore }` /
  `{ messages, hasMore }` with **cursor** pagination — so `response.data.conversations`/`.messages`
  was `undefined` and the hooks crashed at `items.length` ("Cannot read properties of undefined").
  Both handlers now return the SDK shape and honor cursor params: conversations key on
  `cursor`/`cursorCreatedAt` (ordered by `COALESCE(lastMessageAt, createdAt) DESC`); messages key on
  `before` (ISO timestamp) + `sort` + `parentId` (top-level stream vs thread replies).
- **Sign-up no longer 400s when email confirmation is enabled.** `POST /auth/sign-up` treated a
  null `data.user` from supabase-js as failure, but with email confirmation on, GoTrue serializes
  the new user at the top level (no session) and supabase-js's `_sessionResponse` nulls `data.user`
  — so every sign-up returned `400 auth/sign-up-failed` even though the user was created and the
  confirmation email sent. The handler now branches on `error` only: with no session it returns
  `200 { status: "confirmation_required", email }` (no tokens minted; profile created lazily on
  first sign-in); with a session (auto-confirm) it mints tokens as before. The real Supabase error
  message is now surfaced instead of a generic "Sign up failed".
- **Reactions now accept the SDK's field name.** `POST /entities/:id/reactions` and
  `POST /comments/:id/reactions` validated the body against `{ type }`, but the SDK
  (`useAddReaction`) sends `{ reactionType }` — every reaction request 400'd. `reactionSchema`
  now expects `reactionType`, matching the contract; the two handlers were updated accordingly.

## [0.1.1] - 2026-05-24

First public release. The entire REST surface is implemented and validated against live
cloud Supabase — no stubbed endpoints remain.

### Added
- **Content** — entities/feed (hot/new/top/controversial, keyword + metadata + PostGIS geo
  filters), threaded comments, reactions, drafts, saved state.
- **Social graph** — follows, bidirectional connections (friend-request state machine),
  nested spaces with roles/moderation/digests, nestable collections.
- **Auth** — sign-up/in/out, refresh-token rotation with reuse-detection + 30s grace,
  password reset, email verify, external RS256 JWT, OAuth via Supabase.
- **Realtime chat** — conversations/members/messages/reactions/typing/read-state over
  socket.io, byte-compatible with the SDK's event contract.
- **Search** — semantic content search (Voyage `voyage-3.5` + pgvector) and RAG `/search/ask`
  (Anthropic, streamed over SSE); ILIKE text search for spaces/users.
- **Storage** — uploads + `sharp` webp image variants.
- **Webhooks & digests** — Replyke-style HMAC-signed project webhooks (blocking validation
  gates + `*.complete` broadcasts) and per-space content digests
  (`scripts/send-digests.mjs` + secret-gated `POST /internal/cron/digests`).
- **Notifications, reports, moderation** — fan-out inbox, report queues, resolution.
- Idempotent Drizzle migrations `0000`–`0012` (extensions, triggers, RPC, RLS, PostGIS, pgvector).
- Containerization: multi-stage `server/Dockerfile`, `docker-compose.yml`, and a GitHub Actions
  workflow publishing multi-arch (amd64 + arm64) images.
- Apache-2.0 `LICENSE`.

### Notes
- Compatible with the [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) client
  (`@agora/*`), a repointed fork of `@replyke/core`.
- Backlog: rate limiting, refresh-token cleanup sweep, RLS write policies, turnkey deploy guide.

[Unreleased]: https://github.com/jenova-marie/agora/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jenova-marie/agora/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/jenova-marie/agora/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jenova-marie/agora/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jenova-marie/agora/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jenova-marie/agora/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jenova-marie/agora/releases/tag/v0.1.1
