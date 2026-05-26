# Changelog

All notable changes to Agora are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- This changelog.

### Changed
- Docker images are now published to Docker Hub (`agoraserver/agora`) in addition to
  GHCR (`ghcr.io/jenova-marie/agora`).

### Added
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

### Fixed
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

[Unreleased]: https://github.com/jenova-marie/agora/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/jenova-marie/agora/releases/tag/v0.1.1
