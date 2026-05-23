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
- [x] **Vitest harness up + running** (`server/test/`, `app.ts`, `vitest.integration.config.ts`).
      Ongoing coverage tracked in the **Testing** section below.
- [ ] **🔐 Rotate exposed secrets** — Voyage key, Supabase secret/anon keys, DB password (all hit chat transcripts).
- [ ] **Deploy** — host the server (`createApp` split is serverless-ready); set the SDK/demo
      `VITE_API_BASE_URL`; configure Supabase Auth SMTP for real emails.
- [ ] **Push** — add a remote to the `agora` server repo + push; push SDK to `origin` (private mirror).
- [ ] **SDK** — verify `react-native` + `expo` packages; decide publish vs workspace.
- [ ] **Cleanup** — throwaway demo rows (Alpha/Beta/Gamma/Delta/test spaces, test comments).

## Testing

Harness: **vitest** — unit (`src/**/*.test.ts`, no DB) + integration (`test/integration/**`,
real cloud Postgres via `TEST_DATABASE_URL`; in-process `app.request()`, plus a booted server
for socket.io). Commands: `npm test` · `npm run test:integration` · `npm run typecheck`.
Isolation is by `project_id` — each test mints its own project + users and cascade-cleans.

### ✅ Covered
- **Unit (32):** `shape` (shapeUser/Entity/Comment, Date→ISO, deleted-comment blanking,
  parseInclude, generateShortId) · `validation` (parseBody + `{feature}/invalid-body` envelope) ·
  `envelope` (paginate/readPagination clamping) · `errors` (status/code mapping).
- **Integration (32):** entities CRUD + reaction toggle (`toggle_reaction` RPC + `reaction_counts`
  trigger) + `replies_count` trigger + ownership 403 / scoping 404 / auth 401 · **auth token
  rotation** (rotate / 30s grace / reuse-revokes-family / sign-out) · **chat realtime** (handshake
  auth, message:created + message:reaction fan-out, membership-gated room) · **spaces** (roles,
  approval state machine, members_count trigger, moderation gating, owner-only delete) ·
  **connections** (full none→pending→connected/declined machine, directional status, counts).

### P1 — high-risk, untested
- [ ] **Comment reactions** — `toggle_reaction` with `target=comment` (no `refresh_entity_score`).
- [ ] **Collections** — `entity_count` trigger on add/remove · `is-entity-saved` · nested
      sub-collections · per-user ownership scoping.
- [ ] **Users / follows graph** — follow/unfollow edge · followers/following lists + counts ·
      `check-username` · profile PATCH ownership.
- [ ] **Notifications** — list + unread count + mark(-all)-as-read; assert connection-request/
      accepted rows get created (broader fan-out is still an unbuilt P1 feature).

### P2 — fidelity / depth
- [ ] **Entities feed** — hot/new sort + spaceId/userId/keywords filter ordering & pagination ·
      drafts · by-foreign-id/by-short-id · publish · PATCH update. (Note: meaningful hot-rank
      assertions need ≥~10 net votes — `hot_score` is logarithmic.)
- [ ] **Comments** — one-level threaded list via `parentId` · soft-delete content blanking through
      the route · by-foreign-id.
- [ ] **Spaces depth** — rules CRUD + reorder · digest-config (admin-gated, secret masking) ·
      breadcrumb/children · reparenting cycle guard (self/descendant → 400) · by-slug/check-slug · leave.
- [ ] **Reports** — create (entity/comment/message) · moderated list · in-space resolution.
- [ ] **Chat depth** — message edit/delete/remove events · typing relay · member:joined/left ·
      conversation:updated/deleted · thread:reply_count · read-state · group conversations ·
      non-member POST → 403.
- [ ] **Unit: remaining shapers + libs** — shapeSpace/Rule/AuthUser/File/Report + chat shapers ·
      SSRF guard in `utils/get-metadata` · webhook HMAC sign/verify (`lib/webhooks.ts`).

### E2E / external-service (opt-in; need real creds)
- [ ] **Auth (Supabase-backed)** — sign-up / sign-in / change-password / verify-email / password
      reset. (Rotation is already covered without Supabase.)
- [ ] **External auth** — RS256 `verify-external-user` (set a project public key, mint a test JWT).
- [ ] **Search** — `/search/content` + `/ask` (Voyage embed + LLM). `/search/spaces` + `/users`
      are plain ILIKE — no key needed, promote those to P2.
- [ ] **Storage** — `/storage` upload + `/storage/images` variants (Supabase Storage bucket).
- [ ] **Webhooks** — validate (allow/deny/unavailable) + `*.complete` broadcast HMAC delivery
      (against a live test endpoint).
- [ ] **OAuth sign-in** — once `/oauth/authorize` exists (P1 feature).

## Notes
- The server is the trust boundary (Drizzle direct over the pooler; supabase-js only for Auth/Storage).
- Upstream-sync workflow for the SDK fork: `agora-sdk/SYNCING.md`.
- Architecture + conventions: `CLAUDE.md`; DB: `db/README.md`; contract: `docs/MANIFEST.md` + `docs/MODELS.md`.
