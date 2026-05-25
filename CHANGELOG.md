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

### Fixed
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
