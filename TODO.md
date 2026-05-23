# Agora — TODO

> Context: Supabase gave us ~40% for free (Postgres hosting, Auth/GoTrue, Storage, Realtime infra,
> pgvector). The other ~60% — the social schema + the opinionated business logic in front of it —
> is what Agora builds. Most of it is **done**; this is what's left, grounded in the actual code +
> the `@agora` SDK contract. Priorities: **P1** = an SDK feature is broken/missing, **P2** = depth/
> fidelity, **P3** = prod/ops.

## ✅ Done (recap)
Schema + triggers + RPC · entities/comments/reactions/feed · users/follows/connections (incl.
nested spaces + reparenting w/ cycle guard) · collections · reports · auth (sign-in/up/out, token
rotation + reuse-detection, external RS256) · chat (REST + socket.io realtime) · semantic +
text search (Voyage) · storage (uploads + image variants) · misc (oauth identities, projects/lean,
utils/get-metadata) · RLS public-read policies · `@agora` SDK fork repointed · demo app (all domains).

---

## Webhooks (Replyke-style project webhooks) — NEAR-TERM

✅ **Done:** framework (`lib/webhooks.ts`) + config columns (`projects.webhook_url/secret/events`,
migration `0009`) — blocking `validate()` + fire-and-forget `broadcast()`, HMAC `X-Signature`/
`X-Timestamp`, `X-Response-Signature` verification, fail-closed-when-configured. Wired + live-tested
(allow / deny / unavailable) for **`entity.created`** + **`comment.created`** validation and their
`*.created.complete` broadcasts. The lib makes every remaining event a ~3-line wire-up.

**Remaining — finish the event coverage (priority order):**
- [ ] **`notification.created` broadcast** — the push-notification bridge (FCM/APNs/Expo). Highest
      value; depends on notification fan-out (P1 below). Emit from wherever notifications are created.
- [ ] **Validation gates for the rest:** `comment.updated`, `entity.updated`, `space.created`/`space.updated`,
      `message.created` (chat send), `user.created`/`user.updated` (sign-up / profile update). Same
      `await validate(...)` → 403 pattern already used in `entities.ts`/`comments.ts`.
- [ ] **`*.complete` broadcasts** for those same operations (update/space/message/user).
- [ ] **Config surface** — an admin endpoint (or dashboard) to set `webhook_url/secret/events`;
      currently DB-only. Add subscribed-events management + a "test webhook" ping.
- [ ] **Space digest delivery cron** — separate per-space system; `digest_config` columns exist,
      no sender yet (hourly cron → POST `space.digest` envelope, HMAC-signed like project webhooks).

## P1 — SDK features that are missing/broken

- [ ] **Notification fan-out (biggest gap).** Only `connections.ts` creates notifications
      (connection-request/accepted). The other ~15 `AppNotificationType`s are never generated. Wire
      inserts into the write paths:
  - comment create → `entity-comment` (entity author), `comment-reply` (parent author), `*-mention` (mentioned users) — `routes/comments.ts`
  - reaction toggle → `entity-reaction`/`comment-reaction` + the 4 `*-milestone-*` types — `routes/entities.ts`/`comments.ts`
  - follow → `new-follow` — `routes/users.ts`/`follows.ts`
  - space approve → `space-membership-approved` — `routes/spaces.ts`
  - (optional) deliver live via socket.io.
- [ ] **OAuth provider sign-in.** `/oauth/authorize` + `/oauth/link` + callback are NOT implemented
      (only `/oauth/identities` list/delete). The SDK's `useOAuthSignIn` calls these. Wire Supabase
      `signInWithOAuth` (or provider redirect) → mint Agora tokens on callback. (`routes/misc.ts` + `auth.ts`)
- [ ] **`/search/ask`** (RAG/LLM Q&A) — the SDK's `useAskContent`. Retrieve via `match_entities`,
      prompt an LLM (Claude), return an answer + sources. (`routes/search.ts`)
- [ ] **Verify `/search/spaces` + `/search/users` contract.** We fixed `/content` (POST + bare array);
      confirm these two match the SDK's `useSearchSpaces`/`useSearchUsers` method + response shape (ours are GET).
- [ ] **`/crypto/sign-testing-jwt/v2`** — last `notImplemented` stub (dev convenience; signs an
      external-auth JWT). Needed for the SDK's `useSignTestingJwt` quick-start path.

## P2 — fidelity / depth

- [ ] **Full entity-feed filters.** Feed handles only `spaceId/userId/sourceId/keywords/sortBy`.
      SDK sends `followedOnly`, `timeFrame`, `sortByReaction`, `sortType`, and title/content/
      attachments/location/metadata filters (`@agora/core` `interfaces/entity-filters`). (`routes/entities.ts`)
- [ ] **Semantic search beyond entities.** Only entities are embedded. Honor `sourceTypes` by
      indexing comments + chat messages (`lib/embeddings.ts` + `match_entities` → generalize).
- [ ] **Storage image variant modes.** We do fixed thumbnail/small/medium. SDK's `UploadImageOptions`
      has exact-dimensions / aspect-ratio-width|height / original-aspect / multi-aspect-ratio. (`routes/storage.ts`)
- [ ] **Hot-score batch recompute.** `refresh_entity_score` runs per-vote only; add a cron/Edge
      Function for time-decay across the feed (`hot_score` in `0003_functions`).
- [ ] **Mentions** — stored as jsonb but not validated/resolved/notified.
- [ ] **Space depth cap** — cycle guard done; no max-depth limit.
- [ ] **Space digest delivery** — `digest_config` columns exist; no webhook sender.
- [ ] **Comments full-tree endpoint** — `fetch_comment_thread` RPC exists but only the one-level
      (`entityId`+`parentId`) list is exposed.

## P3 — hardening / prod / ops

- [ ] **Rate limiting** — `429` envelope exists, no limiter.
- [ ] **RLS write policies** — only public-read (Option A) done; needed only if the Data API is
      enabled for writes (currently server-only via Drizzle).
- [ ] **Refresh-token cleanup** — expired rows in `refresh_tokens` accrue; add a sweep.
- [ ] **Finish + run the vitest integration suite** (`server/test/`, `app.ts`, `vitest.integration.config.ts` — in progress).
- [ ] **🔐 Rotate exposed secrets** — Voyage key, Supabase secret/anon keys, DB password (all hit chat transcripts).
- [ ] **Deploy** — host the server (`createApp` split is serverless-ready); set the SDK/demo
      `VITE_API_BASE_URL`; configure Supabase Auth SMTP for real emails.
- [ ] **Push** — add a remote to the `agora` server repo + push; push SDK to `origin` (private mirror).
- [ ] **SDK** — verify `react-native` + `expo` packages; decide publish vs workspace.
- [ ] **Cleanup** — throwaway demo rows (Alpha/Beta/Gamma/Delta/test spaces, test comments).

## Notes
- The server is the trust boundary (Drizzle direct over the pooler; supabase-js only for Auth/Storage).
- Upstream-sync workflow for the SDK fork: `agora-sdk/SYNCING.md`.
- Architecture + conventions: `CLAUDE.md`; DB: `db/README.md`; contract: `docs/MANIFEST.md` + `docs/MODELS.md`.
