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
- [x] **`notification.created` broadcast** — the push-notification bridge (FCM/APNs/Expo). Emitted
      from the single `insert()` in `lib/notifications.ts`, so every fanned-out notification fires it
      (no-op unless the project subscribes). Now that fan-out exists (P1, done) this covers all types.
- [x] **Validation gates for the rest (DONE):** `entity.updated` (entities.ts PATCH), `comment.updated`
      (comments.ts PATCH), `space.created`/`space.updated` (spaces.ts POST/PATCH), `message.created`
      (chat.ts send), `user.created` (auth.ts sign-up), `user.updated` (users.ts profile PATCH) — same
      `await validate(...)` → 403 pattern.
- [x] **`*.complete` broadcasts (DONE)** for all of those. Live-verified end-to-end with a real local
      receiver (`scripts/webhooks-events-e2e.mjs`): validation veto→403, allow→write, and HMAC-verified
      `entity.updated`/`space.created`/`message.created`/`user.updated` `.complete` delivery.
- [ ] **Config surface** — an admin endpoint (or dashboard) to set `webhook_url/secret/events`;
      currently DB-only. Add subscribed-events management + a "test webhook" ping.
- [ ] **Space digest delivery cron** — separate per-space system; `digest_config` columns exist,
      no sender yet (hourly cron → POST `space.digest` envelope, HMAC-signed like project webhooks).

## P1 — SDK features that are missing/broken

- [x] **Notification fan-out (DONE).** `lib/notifications.ts` is the single fan-out point; helpers
      wired into every write path. Live-verified end-to-end via `scripts/notifications-e2e.mjs`
      (entity-comment, comment-reply, entity-upvote, entity-reaction, new-follow + self-notify guard
      + metadata shape). Covered:
  - comment create → `entity-comment` (entity author), `comment-reply` (parent author), `comment-mention` (mentioned, deduped) — `routes/comments.ts`
  - entity create → `entity-mention` (mentioned users) — `routes/entities.ts`
  - reaction toggle (active only; `upvote`→`*-upvote`, else `*-reaction`) + the 4 `*-milestone-*` types (thresholds in `MILESTONES`) — `routes/entities.ts`/`comments.ts`
  - follow → `new-follow` (new follows only) — `routes/users.ts`
  - space approve → `space-membership-approved` — `routes/spaces.ts`
  - Not delivered over socket.io (the SDK's socket contract has chat events only — matches Replyke; clients poll the inbox).
  - ⚠️ Untested live (logic + typecheck only): the 4 milestone types (need ≥10 reactions) and
    `space-membership-approved` (needs a pending join). Add to integration coverage.
- [x] **OAuth provider sign-in (DONE).** `/oauth/authorize` + `/oauth/link` + `/oauth/callback`
      implemented in `routes/misc.ts` (Supabase-brokered, code + PKCE). `lib/oauth.ts` builds a
      PKCE-capable anon client (persistSession:true so gotrue actually uses our capturable storage —
      it silently swaps in an internal memory adapter when false); the verifier is persisted in the
      new `oauth_states` table (migration `0010`) between authorize→callback. Callback exchanges the
      code, upserts the profile (keyed by Supabase auth user; username NOT auto-claimed — it's
      unique-per-project), records the `oauth_identities` row + appends to `authMethods`, mints Agora
      tokens, and 302-redirects to `redirectAfterAuth#accessToken=…&refreshToken=…`.
      Live-verified: authorize returns a real Supabase PKCE URL + persists the verifier; callback
      error-passthrough + one-shot state + failed-exchange all redirect correctly. Integration:
      `test/integration/oauth.test.ts` (7). ⚠️ Untested: the real provider consent → successful
      exchange (needs a provider configured in the Supabase dashboard + a browser). `authMethods`
      now reflects linked providers, so `useOAuthSignIn`/`useOAuthLink` are wired end-to-end.
- [x] **`/search/ask`** (RAG/LLM Q&A, DONE) — the SDK's `useAskContent`. Shared `retrieveContent()`
      (match_entities) → stream a Claude answer over SSE (`token`→`sources`→`done`/`error`) via
      `lib/llm.ts` (Anthropic Messages API over fetch, no SDK dep). Env: `ANTHROPIC_API_KEY` +
      `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`) + `ANTHROPIC_MAX_TOKENS`. Live-verified via
      `scripts/ask-e2e.mjs` (grounded answer w/ citations + shaped sources). (`routes/search.ts`)
- [x] **Verify `/search/spaces` + `/search/users` contract (DONE).** Were GET + `{data:[…]}`; the SDK's
      `useSearchSpaces`/`useSearchUsers` POST `{query, limit?}` and expect a BARE `{similarity, record}[]`.
      Rewrote both to POST + bare array (ILIKE + cheap exact/prefix/substring `relevance` score, since
      spaces/users aren't embedded — semantic indexing for them is P2). Live-verified; MANIFEST §search updated.
- [x] **`/crypto/sign-testing-jwt/v2` (DONE).** Implemented in `routes/misc.ts`: the client sends its
      own external-auth private key (PKCS8) + `userData`; we sign an RS256 JWT (issuer=projectId,
      aud="replyke.com", sub=userData.id, claim `userData`) and return it as a bare string — exactly
      what `/auth/verify-external-user` consumes. **Also fixed a latent P1 bug:** verify-external-user
      read `{ token }` but the SDK posts `{ userJwt }` → it now accepts `userJwt` (legacy `token` kept).
      Round-trip live-verified (`scripts/crypto-e2e.mjs`) + `test/integration/crypto.test.ts` (5).
      That clears the last `notImplemented` stub — **the REST surface is now fully implemented.**

## P2 — fidelity / depth

- [x] **Full entity-feed filters (DONE).** `lib/entity-filters.ts` parses the SDK's Axios
      bracket-notation query (`metadataFilters[includes][k]=v`, `keywordsFilters[includes][0]=x`, …)
      into nested objects and translates to SQL: `timeFrame`, `followedOnly`, keywords (has-all /
      has-none), title/content (hasTitle/hasContent + includes/doesNotInclude ILIKE), attachments
      (hasAttachments), metadata (includes/includesAny/doesNotInclude `@>`, exists/doesNotExist
      `?&`/`?|`), location (`ST_DWithin` on the geography column), and sort `hot|top|new|controversial|
      metadata.<key>` + `sortDir`/`sortType`/`sortByReaction`. Gotcha fixed: Drizzle binds a JS array
      in a raw `sql` template as a scalar, so array operands are built as explicit `array[…]::text[]`
      literals. Integration: `test/integration/entity-filters.test.ts` (10). (`routes/entities.ts`)
- [x] **Semantic search beyond entities (DONE).** Generic `content_embeddings` table (migration
      `0011`, backfilled from `entity_embeddings`) keyed by `(source_type, source_id)`; `lib/embeddings.ts`
      → `indexContent(sourceType,…)` wired into entity/comment/message write paths. New `match_content`
      RPC searches across types honoring `sourceTypes`, with per-type liveness + (entity/comment) space
      scope (messages drop out under a space filter). `retrieveContent` hydrates Entity/Comment/
      ChatMessage records in similarity order, so `/content` + `/ask` now return all three. RPC tested
      deterministically (`semantic-search.test.ts`, 4) + full pipeline live-verified (`content-search-e2e.mjs`).
- [x] **Storage image variant modes (DONE).** `lib/image-variants.ts` parses the SDK's
      `UploadImageOptions` multipart fields (mode + JSON params) and computes variant specs for all 5
      modes: `exact-dimensions`, `aspect-ratio-width-based`, `aspect-ratio-height-based`,
      `original-aspect`, `multi-aspect-ratio` (the SDK's FormData builder doesn't serialize the
      multi-aspect fields, so that mode is forward-compat for direct clients); absent mode → legacy
      thumbnail/small/medium. Honors `format` (webp/jpeg/png/original), `quality`, `stripExif`, `fit`,
      `pathParts`. Unit-tested pure (`image-variants.test.ts`, 13) + opt-in real-Supabase e2e
      (`scripts/storage-images-e2e.mjs`). (`routes/storage.ts`)
- [ ] **Hot-score batch recompute.** `refresh_entity_score` runs per-vote only; add a cron/Edge
      Function for time-decay across the feed (`hot_score` in `0003_functions`).
- [ ] **Mentions** — stored as jsonb but not validated/resolved/notified.
- [ ] **Space depth cap** — cycle guard done; no max-depth limit.
- [ ] **Space digest delivery** — `digest_config` columns exist; no webhook sender.
- [x] **Comments full-tree endpoint + contract fixes (DONE).** `GET /comments/thread` exposes the
      `fetch_comment_thread` RPC as a nested `{ data: Comment[] }` (each with a `replies[]`); supports
      `rootId` to scope to a subtree. **Also fixed 3 real SDK-contract gaps** (the SDK does lazy one-
      level loading, so the tree endpoint is server-only bonus — but these mattered): `GET /comments/:id`
      + `/by-foreign-id` now return `{ comment }` (the SDK's `useFetchComment`/`…ByForeignId` read
      `data.comment`); `include=parent` populates `parentComment`; the list honors `sortBy` (`new`=newest
      first default, `old`, `top`=by upvotes). Integration: `comments-contract.test.ts` (6).

## P3 — hardening / prod / ops

- [ ] **Rate limiting** — `429` envelope exists, no limiter.
- [ ] **RLS write policies** — only public-read (Option A) done; needed only if the Data API is
      enabled for writes (currently server-only via Drizzle).
- [ ] **Refresh-token cleanup** — expired rows in `refresh_tokens` accrue; add a sweep.
- [x] **Vitest harness up + running** (`server/test/`, `app.ts`, `vitest.integration.config.ts`).
      Ongoing coverage tracked in the **Testing** section below.
- [x] **🔐 Rotate exposed secrets (DONE)** — Voyage key, Anthropic key, Supabase secret/anon keys,
      DB password rotated; `.env` updated. Server restarted on fresh env + smoke-tested (DB read,
      Voyage search, Supabase Storage upload, Anthropic /ask).
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
- **Unit (44):** `shape` — shapeUser/Entity/Comment + shapeSpace/Rule/AuthUser/Report/File +
  chat shapers (Conversation/Member/ChatMessage); Date→ISO, deleted-comment/message blanking,
  isMember/opt fields, parseInclude, generateShortId · `validation` (parseBody +
  `{feature}/invalid-body` envelope) · `envelope` (paginate/readPagination clamping) · `errors`.
- **Integration (74):** entities CRUD + reaction toggle (`toggle_reaction` RPC + `reaction_counts`
  trigger) + `replies_count` trigger + ownership 403 / scoping 404 / auth 401 · **auth token
  rotation** (rotate / 30s grace / reuse-revokes-family / sign-out) · **chat realtime** (handshake
  auth, message:created + message:reaction fan-out, membership-gated room) · **spaces** (roles,
  approval state machine, members_count trigger, moderation gating, owner-only delete) ·
  **connections** (full none→pending→connected/declined machine, directional status, counts) ·
  **notifications (12)** — fan-out across write paths + self-notify guard + mention dedupe +
  milestone types + inbox list/count/mark(-all)-as-read · **collections** (`entity_count` trigger,
  is-entity-saved, idempotent add, nesting, ownership) · **users+follows** (lookups, username
  availability, follow edge + counts + lists + own /follows views, self-follow/idempotent/unfollow)
  · **reports** (create, validation, create→resolve-in-space→/moderated loop) · **misc** (SSRF
  guard matrix, oauth identities list + ownership-scoped delete, projects/lean) · **webhooks**
  (real local receiver: HMAC request signing + response-signature verify; allow/deny/forged-sig/
  unsubscribed/fail-closed + signed broadcast). Plus oauth + crypto suites from the feature work.

### P1 — dark domains ✅ DONE
- [x] **Collections** — `entity_count` trigger on add/remove · `is-entity-saved` · nested
      sub-collections · per-user ownership scoping. (`collections.test.ts`)
- [x] **Users + follows** — follow/unfollow edge · followers/following lists + counts ·
      `check-username` · profile PATCH ownership. (`users-follows.test.ts`)
- [x] **Reports** — create + moderated list + in-space resolution. (`reports.test.ts`)
- [x] **Misc** — `utils/get-metadata` SSRF guard · oauth identities list/delete · projects/lean.
      (`misc.test.ts`) — `/oauth/authorize|callback` + `lib/oauth.ts` still need an E2E (Supabase network).
- [x] **Notifications** — fan-out + inbox covered (`notifications.test.ts`, 12). Connection-request/
      accepted rows still asserted only indirectly; add explicit assertions to `connections.test.ts`.

### P1.5 — cheap unit wins (pure logic, no DB)
- [x] **`webhooks.ts` HMAC** — covered via `webhooks.test.ts` integration (real receiver verifies
      our `X-Signature`; we verify the receiver's `X-Response-Signature`; allow/deny/forged/fail-closed).
- [x] **SSRF guard** in `utils/get-metadata` — covered in `misc.test.ts` (blocked-host matrix).
- [x] **Remaining shapers** — shapeSpace/Rule/AuthUser/File/Report + chat shapers (`shape-extra.test.ts`).
- [x] **Remaining validation schemas** — space/rule/collection/report/auth covered in
      `validation-extra.test.ts` (createSpace/updateSpace, createRule/reorder, memberRole, moderation,
      createCollection/addEntity, createReport, signUp/signIn/changePassword/email/verifyEmail/oauth/externalUser).

### P2 — fidelity / depth (partial domains)
- [x] **Comment reactions** — `target=comment` toggle (like→1→0, userReaction) in `comments.test.ts`.
- [x] **Entities feed** — covered by `entity-filters.test.ts` (10) from the feed-filters feature work.
- [x] **Comments** — threaded `parentId` list + parent `replies_count` trigger, by-foreign-id, PATCH
      ownership, soft-delete hides the row. (`comments.test.ts`)
- [x] **Spaces depth** — reparenting cycle guard (self/descendant → 400) + valid move/detach,
      breadcrumb/children, rules CRUD + reorder, digest-config (admin-gated + secret masking),
      slug lookup/availability, leave. (`spaces-depth.test.ts`)
- [ ] **Chat depth** — message edit/delete/remove events · typing relay · member:joined/left ·
      conversation:updated/deleted · thread:reply_count · read-state · group conversations ·
      non-member POST → 403.

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
