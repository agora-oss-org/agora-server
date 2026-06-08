# Changelog

All notable changes to Agora are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-06-08

### Removed
- **`apps/moderator` retired.** The Node/Hono LLM-moderation service is fully replaced by the proven
  `services/scorer` subsystem (live-validated end-to-end) — its source is deleted and the `dev:moderator`
  script + workspace/lockfile entries removed. Its prompts, thresholds, verdict parsing, and the
  `moderation_analyses` + admin `/v1/:projectId/moderation/*` contracts live on, ported into the scorer.
  (The dormant `webhooks.ts` moderation-notifier path + the admin Settings→Moderator webhook panel are a
  follow-up cleanup.)

### Security
- **Suspended users are now cut off from realtime (socket.io).** Both the plaintext (`realtime/socket.ts`)
  and the E2E `/secure` (`realtime/secure-socket.ts`) namespaces verified the access JWT but skipped the
  suspension check, so a suspended user with a still-valid token kept receiving live chat events. Both
  handshakes now call `hasActiveSuspension()` after JWT verification and reject with `"suspended"`
  (operators bypass, mirroring `middleware/auth.ts` `requireAuth`).
- **Collections entity endpoints are now project-scoped (cross-tenant isolation).** `POST`/`DELETE`
  `/:id/entities` verify the target entity belongs to the request's project before mutating the join,
  and `GET /:id/entities` filters its count + rows by `entities.project_id`. Previously a foreign
  `entityId` could be linked into a same-owner collection and read back, leaking another project's
  entity (`routes/collections.ts`). Backed by a DB trigger (`0034_collection_entity_same_project`)
  that rejects any `collection_entities` row whose collection and entity differ in `project_id` — a
  last-line backstop independent of the handler checks.
- **External-auth public key is strength-validated before use.** `verify-external-user` now rejects a
  configured `external_auth_public_key` that isn't RSA ≥2048-bit before verifying any token signed by
  it, so a weak/wrong-type key can never gate identity (`routes/auth.ts`).

### Added
- **`@agora-server/contract` exports secure-chat request-body types.** `packages/contract/src/secure-chat.ts`
  now exports `RegisterDeviceBody`, `PublishKeyPackagesBody`, `CreateSecureConversationBody`,
  `AddSecureMemberBody`, `RemoveSecureMemberBody`, `SendSecureMessageBody`, `UploadKeyBackupBody`,
  `WelcomeEnvelope`, and `HandshakeBlob` (`z.input` of the existing schemas, so `.default()`/`.nullish()`
  fields are optional client-side) — so SDK/client code can type secure-chat request payloads without
  redeclaring the shapes. Contract bumped to 0.9.3.
- **`genesis` / `genesis:test` scripts — one-command DB reset-and-seed.** `apps/api/scripts/genesis.mjs`
  chains drop → migrate → `seed.sql` (tenant fixtures + trigger/RPC asserts) for a from-nothing rebuild.
  `pnpm genesis` targets `DATABASE_URL`; `pnpm genesis:test` targets `TEST_DATABASE_URL` (override applied
  to the child so it can never touch the dev DB). DESTRUCTIVE: keeps `drop.mjs`'s type-the-ref confirm by
  default; pass `--force` for non-interactive/CI. Seeds DB-level fixtures only — the demo content posts
  (`seed-*-post.mjs`, need a running server) stay behind `pnpm seed`.

### Fixed
- **`scripts/drop.mjs` now drops the `drizzle` migration ledger too.** The script dropped only `private`
  + `public`, but drizzle-orm's `__drizzle_migrations` ledger lives in its default `drizzle` schema —
  which survived the drop. The follow-up `--migrate` then read the stale full ledger, saw the high-water
  mark already at the latest migration, and **silently no-op'd**, leaving an empty schema that *looked*
  fully migrated. The drop transaction now also `DROP SCHEMA IF EXISTS drizzle CASCADE` so the ledger
  resets and the rebuild actually re-applies `0000…N` (comment/banner corrected to match).

## [0.9.2] - 2026-06-07

### Added
- **Scorer: LISTEN/NOTIFY wake-up + operator-complete admin surface.** The `services/scorer` worker now
  wakes instantly on a `pg_notify('scorer_jobs')` from the enqueue trigger (migration `0033`) — via a
  dedicated LISTEN connection on a direct/session DSN (`SCORER_LISTEN_DATABASE_URL`; LISTEN doesn't work
  over the `:6543` transaction pooler) — with the pgmq poll retained as the durability backstop. The
  admin AI-flag surface is now contract-complete with `apps/admin`: the queue populates `author` (batched,
  incl. chat messages), pagination matches `@agora-server/contract` (`pageSize`/`totalItems`/`hasMore`),
  `/analysis` returns `{analysis}`, `/analyze` + `/{id}/remove` are implemented (a reusable
  `assess_and_record` cascade core; remove writes back through the API), `resolve`/`remove` return the
  updated `ModerationAnalysis`, and `/config` returns the full running-config shape. A manual end-to-end
  **smoke recipe** is documented in `docs/SCORER.md` (the live smoke is the remaining gate).

### Changed
- **Secure chat: the `SecureChatCrypto` seam moved to the SDK.** It's client code (the server's only
  users were two integration tests), so it now lives in the `agora-sdk-plus` repo as
  `@agora-sdk/secure-chat-crypto` (Apache-2.0); this repo deleted `packages/secure-chat-core/` and
  devDepends on its `/testing` mock instead. `@agora-server/contract` is now **publishable** (dropped
  `private: true`) as the Apache-2.0 wire-contract source of truth the SDK builds on — the dependency
  arrow is SDK → contract, never the reverse. No server runtime change (DS, routes, schema, socket, and
  the contract `secure-chat` types are untouched). Channel committer **decided**: channels deferred, MLS
  External Commits is the design when they land.
- **Renamed `@agora/contract` → `@agora-server/contract`.** The shared wire-contract package moved to the
  `@agora-server` npm scope (matches the repo + the scope it publishes under). All workspace importers and
  the publish workflow were repointed; the AGPL apps keep their `@agora/*` names (private, never published).

### Added
- **`npm-publish` CI workflow.** `.github/workflows/npm-publish.yml` publishes `@agora-server/contract`
  (Apache-2.0) to npm on a `v*` tag (or manual dispatch) — idempotent (skips if the version is already
  published), with npm provenance. Requires an `NPM_TOKEN` repo secret. The AGPL apps stay `private`.

### Fixed
- **Docker builds: drop the deleted `secure-chat-core`, repoint the renamed contract.** `apps/api/Dockerfile`
  no longer `COPY`s / builds `packages/secure-chat-core` (it was moved to the SDK repo as the published
  `@agora-sdk/secure-chat-crypto` devDep), which had broken `build-and-push` at the COPY step. The api,
  moderator, and admin Dockerfiles now build the renamed `@agora-server/contract` workspace package (the
  stale `@agora/contract` filter would no longer match). Contract is still built from in-image workspace
  source (`workspace:*` → `link:`), never pulled from npm — so the image build is independent of the
  `npm-publish` workflow (no ordering/race between them).
- **`@agora-server/contract` npm publish: add the `repository` field.** npm provenance (`--provenance`)
  rejects a bundle whose `package.json` lacks a `repository.url` matching the source repo (`422
  Unprocessable Entity`), which silently no-op'd the publish on the `v0.9.1` tag. Added `repository`
  (+ `homepage`) so the provenance attestation validates and the package publishes. (`v0.9.1` was tagged
  but produced no npm artifact; `0.9.2` is the first published release of the contract.)

### Added
- **Secure chat (end-to-end-encrypted, MLS/RFC-9420) — Phase 1: the blind Delivery Service.** A brand
  new, separate path from the Replyke-compatible plaintext chat (which is untouched), where the server
  **cannot read messages** — it stores/relays only opaque ciphertext and learns social-graph + timing
  metadata (the Signal-server model). No LLM moderation, embeddings, or search run over secure chat,
  by design. New surface (all crypto is client-side; the server depends on no crypto library):
  - **REST** `/v7/:projectId/secure-chat/*` (`routes/secure-chat.ts`): device registration + public
    device directory; one-time MLS KeyPackage publish/count/**atomic claim** (`409
    secure-chat/key-packages-exhausted` when depleted); create conversation (`dm`/`group`/`channel`,
    channels gated by space membership); add/remove member with **optimistic epoch linearization**
    (`409 secure-chat/epoch-conflict`); send/list opaque ciphertext messages; per-device
    Welcome/Commit handshake inbox (monotonic `seq` cursor); and a passphrase-encrypted **key backup**
    the server can't decrypt (history restore on a new browser).
  - **Realtime** a separate socket.io `/secure` namespace (`realtime/secure-socket.ts`) for
    ciphertext-only fan-out — `secure:message`, broadcast `secure:handshake`, device-targeted
    `secure:welcome`, plus member/typing/key-package-low signals.
  - **Schema** seven `bytea`-backed tables (`db/schema/secure-chat.ts`, migrations `0031`/`0032`),
    multi-device-ready (a device = an MLS leaf) and **RLS deny-all** (no `authenticated` SELECT grant).
  - **Contract** new `@agora/contract` `secure-chat` module (base64 binary, string epochs); new
    workspace package **`@agora/secure-chat-core`** holding the `SecureChatCrypto` seam (so ts-mls vs
    OpenMLS-WASM is a deferred, swappable choice) + a deterministic mock used by the integration suite
    (which asserts the stored ciphertext never contains the plaintext). See `CHAT_TODO.md` for Phase 2
    (web client crypto + IndexedDB + passphrase UX) and Phase 3 (React Native/Expo + full multi-device).

### Fixed
- **Scorer: gate on P(toxic), not the top label.** The `services/scorer` cascade compared the toxicity
  classifier's *top-label* probability to the gray-zone thresholds, so clean content whose top label was
  `neutral` (e.g. 0.95) wrongly tripped the block gate. It now keys on **P(toxic)** specifically (falling
  back to the top score only if a model lacks a `toxic` label), covered by `worker/pipeline.py` cascade
  tests (clean→allow / toxic→block / gray-zone→review). Also made the scorer **mypy-clean** (added
  `[tool.mypy]` + Literal-narrowing fixes in `verdict.py` / `neo4j.py` / `pipeline.py`).

## [0.8.0] - 2026-06-06

### Added
- **Admin: view-only Settings mode (`VITE_SETTINGS_READ_ONLY`).** Set to `true` to disable every Save
  control on the admin Settings page (feed ranking, moderator, stewardship, webhooks) and block submits
  client-side, plus a "view-only" banner — so the admin can be deployed for viewing/operation without
  allowing settings changes. UI guard only (the API still authorizes writes by operator token), not a
  security boundary. New `SETTINGS_READ_ONLY` in `apps/admin/src/config.ts`.

### Fixed
- **`pnpm db:migrate` now reads the correct journal.** `drizzle.config.ts` `migrations.schema` was
  `public` while the runtime migrator (`scripts/migrate.mjs` / `db:migrate:run`) writes the journal in
  the `drizzle` schema — so `db:migrate` saw an empty journal and tried to re-apply from `0000`. Pointed
  drizzle-kit at the `drizzle` schema so both runners agree.

### Security
- **Upload size + image-dimension caps.** Every upload path now enforces a `MAX_UPLOAD_BYTES` byte cap
  (default 25 MiB → `413 storage/file-too-large`) before buffering, plus a **50 MP** image limit
  (`sharp`'s `limitInputPixels` + a metadata pre-check → `413 storage/image-too-large`) to stop
  decompression-bomb / OOM uploads — defense-in-depth alongside the proxy's body cap. New
  `assertUploadSize` (`lib/storage.ts`); `Errors.tooLarge` (413).
- **Hardened JWT verification + secret strength.** `jwtVerify` now **pins the algorithm** — `["HS256"]`
  on the access-token and socket.io verifies (and the moderator service), `["RS256"]` on the external-
  auth verify — closing algorithm-confusion. **`ACCESS_TOKEN_SECRET`** is now validated as **≥ 32 chars**
  (was non-empty only).
- **Rate limiting: spoof-resistant client IP + optional cross-replica Redis store.** The limiter no
  longer keys on the **left-most** (client-supplied, spoofable) `X-Forwarded-For` hop — it reads the
  real client IP **`RATE_LIMIT_TRUSTED_HOPS` hops from the right** (default 1; the entries trusted
  proxies actually appended), falling back to `X-Real-IP`. New optional **`REDIS_URL`** swaps the
  in-process counter for a shared Redis store (atomic fixed-window Lua) so the cap holds across
  multiple api replicas; **fail-opens to in-memory** if Redis is unreachable, and stays off unless
  `RATE_LIMIT_MAX` is set. Adds `ioredis`, a `scale`-profiled `redis` service in `docker-compose.yml`,
  and a documented least-privilege Redis ACL (`apps/api/README.md`). New `lib/redis.ts` +
  `clientIp`/`RateLimitStore`/`redisStore` in `lib/rate-limit.ts`, with unit coverage.
- **Enforce user suspensions server-side.** A suspended user is now blocked on **every authenticated
  request** (`requireAuth` → `403 auth/suspended`), not just at token refresh — previously
  `user_suspensions` were reported to the client but never enforced, so a suspended user's access token
  kept working until expiry. Operators bypass the check (they lift). Suspending also revokes the user's
  refresh families so the session can't be renewed. Adds operator-only endpoints to manage it
  (`GET/POST/DELETE /v7/:projectId/users/:id/suspend[sions]`) and an index on `user_suspensions.profile_id`
  (migration `0026`). New `lib/suspensions.ts` (`isActiveSuspension` / `hasActiveSuspension` / `suspendUser`
  / `liftSuspensions`) with unit + integration coverage.
- **Hardened `/utils/get-metadata` against SSRF.** The link-preview fetcher now validates the target host
  on the initial URL **and every redirect hop** (manual redirect following), **resolves** the host and
  rejects any private resolved IP, and covers cases the old string check missed — IPv6 (incl.
  IPv4-mapped `::ffff:…`), ULA/link-local, and numeric-IP encodings (decimal/octal/hex). Previously a
  public URL that `302`-redirected to `169.254.169.254`/`127.0.0.1` was followed unchecked. New guard in
  `apps/api/src/lib/ssrf.ts` (`isPrivateIp` / `assertPublicUrl` / `safeFetchText`) with unit coverage.

### Added
- **Steward: mediation channels.** Stewards can now bring a case's parties into a private, async space
  to talk it through — built on the existing chat (the channel is a `conversations` row linked via the new
  `conversations.steward_case_id`; messaging flows through the normal `/chat` routes). Two shapes,
  governed by a per-project **mediation mode** (admin Settings → Stewardship): **caucus** (steward ↔ each
  party privately — always available, preserves respondent anonymity) and, in **hybrid** mode (default), an
  optional **joint room** with both parties, offered only when both consent and the case isn't flagged
  targeting. Channel wind-down on close is also configurable (**mediationOnClose**: archive-read-only /
  lock-leave / leave-open). New migration `0030` (`steward_case_id` + `mediation_opened`/`mediation_closed`
  event kinds), `lib/mediation.ts` (with the pure `canOpenJoint` guard), `notifyMediationInvite`,
  `GET`+`POST /steward/cases/:id/channels`, and an admin case Mediation panel (open channels + inline
  thread) plus the two new Settings controls.
- **Steward: participant notifications (configurable policy).** The complainant/respondent in a
  conflict-resolution case are now told what's happening via in-app notifications, governed by a
  per-project **notify policy** (admin Settings → Stewardship): **power-aware** (default — complainant
  every stage, respondent only when their content is removed, never told who raised it), **symmetric**
  (both every stage), or **resolution-only** (close only). Respondent notifications never carry the
  complainant's identity. New `projects.steward_config` (migration `0029`), `lib/steward-config.ts`,
  `notifyStewardCaseEvent` + the pure `stewardCaseRecipients` matrix in `lib/notifications.ts` (fired at
  open / in-mediation / close / escalate), `GET`+`PATCH /settings/steward`, and the admin Stewardship
  settings panel. Notifications are polled (no realtime); the forked SDK renders the new types generically
  until it adds them.
- **Admin: Help & Resources page.** A new **Help** sidebar item and dedicated `/help` route shows
  learning resources: a link to explore **books on building online communities** (Amazon search,
  results unordered) and a placeholder for **online documentation** (coming soon).
- **Bundled TLS edge proxy (Caddy) — optional single front door.** A new `proxy` service in
  `docker-compose.yml`, gated behind the **`edge` profile** (`docker compose --profile edge up`), that
  terminates HTTPS with **automatic Let's Encrypt certs** (auto-renewed; internal CA for `localhost` so
  dev needs no setup), adds HSTS + security headers (`X-Content-Type-Options`/`Referrer-Policy`/
  `X-Frame-Options`, strips `Server`), caps request bodies (`MAX_BODY_SIZE`, default 25MB), and stamps an
  **authoritative `X-Forwarded-For`** (ignores client-supplied values), reverse-proxying to the admin
  nginx. Satisfies the `SECURITY.md` TLS/headers/forwarded-IP/body-size checklist out of the box; set
  `RATE_LIMIT_TRUSTED_HOPS=2` behind it. `deploy/proxy/Caddyfile` + `deploy/proxy/README.md`; the default
  (no-profile) deploy is unchanged.
- **`SECURITY.md` — security policy + operator hardening guide.** Documents the vulnerability-disclosure
  process (private reporting + contact), supported versions, and a deploy-time **hardening checklist**
  (terminate TLS/HSTS at the proxy, `sslmode=require` for the DB in transit + at-rest notes, strong-secret
  generation, the service-role-key boundary, `CORS_ORIGIN`, rate-limit env, trusted-proxy `X-Forwarded-For`,
  upload-size caps, backups). Also writes down the **security model** (server-as-trust-boundary, RLS
  defense-in-depth, JWT rotation/reuse-detection, tenant isolation, constant-time secret compares) and an
  honest **known-limitations / hardening roadmap** (link-preview SSRF redirects, server-side suspension
  enforcement, multi-replica rate-limit durability, upload bounds, public storage bucket, secret-length +
  JWT-algorithm pinning).
- **`services/scorer` — Python scoring/moderation subsystem (foundation).** A new subsystem that
  **replaces `@agora/moderator`**: async, post-publish moderation off a **Supabase pgmq** queue, fed by
  a Postgres trigger (migration `0027_scorer_pgmq_enqueue`) that enqueues a job atomically with each
  content INSERT/content-changing UPDATE on `entities`, `comments`, and `chat_messages`. Three
  containers — two RoBERTa model servers (toxicity + relationship-quality, warm in RAM, CPU-pinned) and
  a worker that scores both in parallel, **cascades** borderline toxicity to **Claude Haiku**, writes
  removals back through the API (`/internal/moderation/apply`, unchanged), records `moderation_analyses`,
  and MERGEs a relationship edge into a bundled **Neo4j**. Preserves the admin AI-flag contract
  (`/v1/:projectId/moderation/*` shapes + operator JWT). The salvaged policy prompts, auto-action
  thresholds, and verdict parsing are ported verbatim. The RoBERTa model server, asyncpg db layer, pgmq
  consumer, Haiku adjudication + write-back, and a v1 Neo4j relationship graph (author→content + signed
  sentiment) are all implemented (unit-tested where feasible — pure logic + the HTTP paths via mocks;
  pending a live integration smoke). Idempotency under pgmq's at-least-once redelivery is by
  `source_msg_id` dedup on `moderation_analyses` (`ON CONFLICT DO NOTHING`, partial unique index,
  migration `0028_scorer_analysis_dedup`), preserving the append-log + cumulative stats. Docs:
  `docs/SCORER.md`, `docs/superpowers/specs/2026-06-05-scorer-architecture.md`. See `services/scorer/`.

### Changed
- **Steward escalation now removes chat messages.** `POST /steward/cases/:id/escalate` previously rejected
  `subjectType:"message"`; it now stamps the message `moderationStatus="removed"` (`moderatedByType="user"`)
  like entities/comments, **hides removed messages** from conversation members on read
  (`GET /chat/conversations/:id/messages` now applies the moderation gate; operators still see them), and
  fans out the realtime `message:removed` event. Case detail (`GET /steward/cases/:id`) hydrates the
  message subject so the steward sees what they're removing.
- **Moderation enqueue moved from the HMAC webhook to a pgmq Postgres trigger** (migration `0027`). The
  `apps/api/src/lib/webhooks.ts` `MODERATION_EVENTS` notifier path is superseded (left in place for the
  external-webhook half; dead-after-cutover cleanup deferred).
- **Admin AI-flag-queue upstream repointed** from `@agora/moderator` to the new `scorer-worker`
  (compose `MODERATOR_UPSTREAM`); the nginx rewrite and the served `/v1/:projectId/moderation/*` shapes
  are unchanged.

### Removed
- **`moderator` retired from `docker-compose.yml`** (replaced by `services/scorer`). The
  `apps/moderator` source is left in the tree; its deletion is a follow-up.

## [0.7.0] - 2026-06-05

### Added
- **Steward — conflict resolution (Caseload v1).** A new admin **Steward** tab and a new **Steward
  role** — a trust tier *between* member and operator for resolving conflicts between members
  (distinct from moderation, which judges content). The role is a **DB-backed grant** (operators grant
  community members) that rides the same JWT path as `isOperator`: stamped at mint/refresh, read back
  on every request as **`c.var.auth.isSteward`** (additive `AuthUser.isSteward` /
  `AuthContext.isSteward` in `@agora/contract`). A **case** records a dyadic conflict (complainant vs
  respondent) over some content, moves through `open → in_mediation → closed`, and closes with a
  **transformative-leaning outcome** (the outcome enum is ordered repair → separation → protection →
  dismissal; `escalated` — the only one that removes content — is reached solely via the escalate
  action). An **`asymmetry`** flag marks "targeting, not a symmetric dispute." Every action appends to
  an append-only `steward_case_events` timeline.
  - **Schema** (migration `0025`): `project_stewards` (the grant), `steward_cases`, `steward_case_events`
    + enums `steward_case_state` / `steward_case_outcome` / `steward_case_event_kind`.
  - **API** (`routes/steward.ts`, mounted at `/v7/:projectId/steward`, gated steward||operator):
    `GET /steward/cases` (caseload, by state/assignee), `POST /steward/cases` (open — cold or seeded
    from a `reportId`), `GET /steward/cases/:id` (parties + subject content + timeline),
    `PATCH /steward/cases/:id` (state/assignee/asymmetry/outcome + note), `POST /steward/cases/:id/notes`,
    and `POST /steward/cases/:id/escalate` (removes the subject content as `moderatedByType="user"`,
    closes the case, resolves the originating report). Operator-only grant management:
    `GET/POST /steward/stewards`, `DELETE /steward/stewards/:userId`.
  - **Admin**: the operator-or-steward **Steward** tab (caseload list + case-detail dialog with the
    asymmetry toggle, transformative outcome menu, and Escalate &amp; remove), an operator-only
    Stewards grant card, and an **"Open steward case"** action on the Moderation review dialog that
    seeds a case from a report.
  - **Docs**: `STEWARDSHIP.md` — a (draft) steward-facing guide to the model, the philosophy, and the
    caseload workflow; grows as the Watch and mediation-channel pieces land.

## [0.6.0] - 2026-06-03

### Added
- **`db:drop` — rebuild-the-schema tooling.** New `apps/api/scripts/drop.mjs` (`pnpm db:drop`) drops the
  app schema **objects** (where `db:wipe` only TRUNCATEs rows): `DROP SCHEMA private CASCADE` +
  `DROP SCHEMA public CASCADE` (tables, enums, functions, triggers, the migration ledger, and the
  public-installed pgcrypto/vector/postgis extensions), then recreates an empty `public` with the
  baseline Supabase schema grants — so `migrate.mjs` can rebuild from `0000`. Leaves the Supabase-managed
  `auth` schema (and Auth users / Storage) untouched. Mirrors `wipe.mjs` safety: dry-run by default,
  `--yes` to execute, type-the-ref confirm in a TTY (`--force` for CI), atomic drop+recreate, and a
  `--migrate` flag to chain the rebuild (`node scripts/drop.mjs --yes --migrate`).
- **Community dashboard — operator-only community-health pulse.** A new **Community** tab in the admin
  (operator-gated `/community`) shows the felt sense of the deployment: **pulse cards** (all-time
  members/posts/comments/reactions with their trailing-24h delta), **per-day growth charts**, **activity
  leaderboards** (top posters/commenters/reactors ranked by volume in the window, with each
  contributor's reputation), **top posts** (ranked by reactions + replies, deep-linked into the demo app
  via `?entity=`), and **moderation pressure** (reports opened vs resolved + the live open count). Backed
  by a new **hourly rollup**: `community_stats_hourly` (migration `0024`, one row per project per hour —
  flow counts, cumulative all-time totals, and leaderboard/top-post JSON snapshots), written by
  `rollupCommunityStats()` (`lib/community-stats.ts`) which re-derives a trailing 25h window each run so a
  missed run self-heals. Driven by a new secret-gated cron **`POST /internal/cron/community-stats`**
  (+ standalone `scripts/rollup-community-stats.mjs`), and read back through the operator-only
  **`GET /admin/community/overview?days=N`**.
- **Dashboard: server container resources (free memory + disk).** `GET /admin/dashboard/metrics` now
  returns `serverMetrics` (operator-only) — the running API container's free/total **memory** and
  **disk**, rendered as a **"Server resources"** section on the admin Dashboard beside the DB size.
  Memory is **cgroup-aware** (reads `/sys/fs/cgroup/memory.{max,current}` v2 / `memory.{limit,usage}_in_bytes`
  v1 so it reflects the container limit, not the host; falls back to `os` when unlimited); disk uses
  `fs.statfs` (`lib/server-resources.ts`). Fail-soft (null fields on read error). Note: on a
  multi-replica deploy it reflects whichever container served the request.
- **Server-side Umami analytics.** The API reports discrete product-usage events to a Umami instance
  (`POST {AGORA_UMAMI_URL}{AGORA_UMAMI_SEND_PATH}`, default collect path `/api/send`). `AGORA_UMAMI_URL`
  may carry a path prefix (e.g. `https://host/umami` to consolidate all Umami routes under one mount —
  the prefix is preserved when building every endpoint): `entity-created`, `comment-created`, `message-created`,
  `user-signup`, `space-created`, `space-joined`, `reaction-added`, `follow-added`, `report-created`,
  `conversation-created`, `connection-requested`, `connection-accepted`, and `search` (with a `kind`). Each
  carries `projectId` in its event `data` for per-tenant filtering; no PII or content is sent. A new
  fire-and-forget client (`lib/umami.ts`) sends best-effort on the create/add path only (never blocks
  or fails a request), and is a **no-op unless `AGORA_UMAMI_URL` + `_SERVER_ID` + `_SERVER_HOSTNAME` are set**
  (`_API_KEY` optional). Aggregate request metering stays in `api_usage`/the admin dashboard — only
  discrete events go to Umami. A third, external product-analytics sink alongside `api_usage` + OTel.
- **Admin Umami analytics — instrumentation + an operator Analytics page.** The admin SPA now loads
  Umami's tracking script (build-time injection in `vite.config`, gated on `AGORA_UMAMI_URL` +
  `AGORA_UMAMI_ADMIN_ID` — a **separate** Umami website from the server-events one), giving automatic
  pageviews plus custom events (`lib/analytics.ts` `track()`): `admin-login`/`admin-logout`,
  `admin-moderation-action` (report + AI-flag remove/dismiss/approve), `admin-reanalyze`, and
  `admin-settings-save`/`admin-settings-test` (moderator/webhooks/feed panels). A new **operator-only
  Analytics page** (`/analytics`, sidebar item shown to operators) reads stats back through a new
  **operator-gated API proxy** `GET /admin/umami/overview?site=product|admin&days=N`
  (`lib/umami-reporting.ts`). The **Admin app** tab shows summary stats + a daily pageviews series +
  top events; the **Agora server** tab is event-centric (it has no pageviews) — **Total events**, an
  **Events-over-time** trend, **Top events**, and **Event properties** breakdowns of the custom event
  `data` we attach (e.g. search by `kind`, reactions by `type`; identifier-ish `…Id` props filtered).
  The event-data reads are best-effort (older Umami without those endpoints degrades gracefully). The
  proxy authenticates **server-side only** (credentials never reach the browser):
  **self-hosted** Umami via `POST /api/auth/login` → Bearer token (`AGORA_UMAMI_USERNAME` /
  `AGORA_UMAMI_PASSWORD`, cached + re-login on expiry), with `AGORA_UMAMI_API_KEY` (`x-umami-api-key`)
  as a **Umami-Cloud** fallback. Reads the reporting API at `AGORA_UMAMI_API_URL` (falls back to
  `AGORA_UMAMI_URL`), and degrades gracefully when reporting isn't configured.
- **Moderation: poster + flagger names in the queues and review dialogs.** Report list/detail now
  resolve the **poster** (content author) and **flagger** (reporter) display names — new `Report.author`
  / `Report.reporter` (`UserSummary`) populated by `/reports/pending` + `/moderated` (batched author
  lookup via the target row). The AI-flag queue resolves just the **poster** (`ModerationAnalysis.author`,
  the moderator joins target → profile). Admin shows **Poster** + **Flagger** columns in the reports
  grid (Poster only in the AI-flags grid) and a poster/flagger header at the top of both review dialogs.
  `UserSummary` carries the poster's **reputation** (the trigger-maintained `profiles.reputation`),
  shown beside the poster's name (`<Poster>`) in the grids and dialog headers.
- **Moderator: editable per-project moderation categories.** The category taxonomy the agent steers
  the LLM toward is now per-project, stored in `moderator_config.categories` and **editable in admin
  Settings → Agent moderation** (add/remove chips + reset-to-defaults). The starting list is the
  shared `DEFAULT_MODERATION_CATEGORIES` (`@agora/contract`); the moderator **seeds it into a project
  that has none** on first use, then pulls the project's list and lists exactly those categories in
  the model's system prompt (`buildSystemPrompt`). `GET /settings/moderator` returns the effective
  list (stored, or the seed defaults); clearing all resets to defaults.
- **Moderator: automated-moderation metrics on the admin dashboard.** The moderator now records LLM
  **token usage** per assessment (`moderation_analyses.prompt_tokens` + `completion_tokens`,
  migration `0023`; captured from the OpenAI/Anthropic `usage` field, `0` when the host omits it) and
  exposes `GET /v1/:projectId/moderation/stats` (operator-only) aggregating, all-time for the project:
  total moderations, **block** + **review** verdict counts, **auto-blocks** (auto-removed), and total
  prompt/completion token usage. The admin **Dashboard** shows these as an **"Automated moderation"**
  section, rendered only when the moderator is reachable (i.e. auto-moderation is enabled).
- **Moderator: review auto-action threshold** — a second, independent confidence floor that
  auto-removes a `"review"` verdict (env `MODERATION_REVIEW_AUTO_ACTION_THRESHOLD`, per-project
  `moderator_config.reviewAutoActionThreshold`, default **`0` = off**). `"review"` still means "route
  to a human" by default; raising this opts a project into auto-acting on high-confidence reviews. The
  decision is a pure, unit-tested function (`lib/auto-action.ts`). Editable in admin Settings →
  Moderator alongside the block threshold, with its effective (override ?? env default) value shown.

### Changed
- **Seed scripts reorganized into `scripts/seeds/` with a one-shot runner.** All seeders (the auth-user
  seeder, `seed.sql`, and the post seeders) moved from `apps/api/scripts/` into `apps/api/scripts/seeds/`.
  A new **`scripts/seeds/seed.mjs`** orchestrator runs every sibling `*.mjs` in sequence — the
  account-creating `seed-demo-user.mjs` first (fatal if it fails), then each idempotent post seeder
  (a single failure is reported but doesn't stop the rest). Ten new topical post seeders were added
  (stargazing, sourdough, trail run, monstera, vinyl, cold brew, tide pools, mechanical keyboard, bike
  commute, watercolor), each with a reliable `picsum.photos` default image overridable via a per-post
  `*_IMAGE_URL` env. The many `seed:*` npm scripts are **consolidated into a single `pnpm seed`**
  (`node scripts/seeds/seed.mjs`); individual seeders remain runnable directly. The seeded/operator
  default user is now **`agora-admin@gmail.com`** (was `agora-demo@gmail.com`). `seed.sql` is still run
  separately via psql (`-f scripts/seeds/seed.sql`).
- **Umami: trace logging on every event emit.** The API's `trackEvent` logs `umami: sending event`
  (name + endpoint + website) at `trace` and `umami: event sent` on success; the admin's `track()`
  logs each emit to `console.debug` with whether `window.umami` is present (`→ sent` / `→ dropped`).
  Makes it instantly visible whether browser custom events are firing or being dropped (e.g. blocked).
- **Moderator: renamed the block auto-action threshold** for symmetry with the new review threshold —
  env `MODERATION_AUTO_ACTION_THRESHOLD` → **`MODERATION_BLOCK_AUTO_ACTION_THRESHOLD`** (default
  `0.85`, behavior unchanged), and the `projects.moderator_config` jsonb key `autoActionThreshold` →
  **`blockAutoActionThreshold`** (contract `moderatorConfigSchema` + `GET/PATCH /settings/moderator`).
  **Breaking config rename, no data migration:** update the env var name, and any project that saved a
  per-project `autoActionThreshold` override must re-save it under the new field (old key is ignored →
  falls back to the env default).

### Removed
- **Moderation "removed content" is now always _hide completely_** — dropped the `hide` vs
  `placeholder` choice. Removed the admin **Settings → Moderation** panel, the
  `GET`/`PATCH /settings/moderation` endpoints, the `moderationConfigSchema`, `lib/moderation-config.ts`,
  and the placeholder/redact path in `lib/moderation-visibility.ts` (`shouldRedact`/`redactEntity`/
  `redactComment`/`redactRemovedList`). Removed entities/comments are filtered from lists/threads and
  404 on direct reads for non-moderators (operators still review them). The orphaned
  `projects.moderation_config` column is left in place (no migration); safe to drop later.

## [0.5.0] - 2026-05-31

### Added
- **API: `GET /admin/config`** — the running configuration (deployment-level), **operator-only**.
  Returns the resolved server config with **all secrets redacted** to `*Set`/`*Enabled` booleans
  (only non-sensitive values — ports, TTLs, model names, public URLs, feature toggles — are echoed;
  `DATABASE_URL` is reduced to host + db name with credentials stripped), plus runtime facts (node
  version, pid, uptime). Built by the pure, unit-tested `lib/running-config.ts` (a test asserts no
  secret value can leak).
- **Moderator: `GET /v1/:projectId/moderation/config`** — the same secret-redacted running-config
  view for the `@agora/moderator` service, **operator-only** (the moderation router's existing gate).
  Reports the service env (port, DB host, write-back wiring) plus the LLM `defaults` block (provider,
  model, `apiKeySet`, threshold) — labelled `defaults` because projects override it via
  `projects.moderator_config`. Same pure + no-leak-tested `lib/running-config.ts` pattern.
- **New app: `@agora/moderator` — LLM-backed content moderation.** A standalone Hono service
  (`apps/moderator`, default port 4001) that automatically moderates content with a **generic LLM
  provider** (OpenAI-compatible `/chat/completions` *or* Anthropic `/v1/messages`, selected by
  `MODERATOR_LLM_PROVIDER`). It:
  - **Receives the API's existing broadcast webhooks** (`entity.created.complete`,
    `comment.created.complete`, `*.updated.complete`, `message.created.complete`) at
    `POST /webhooks/agora`, verifying the HMAC `X-Signature` against the per-project `webhookSecret`.
    Content goes live first, then is assessed asynchronously (no creation latency).
  - **Auto-acts** above a confidence threshold (`MODERATION_AUTO_ACTION_THRESHOLD`, default `0.85`):
    a `verdict: "block"` writes the removal back to the API as `moderatedByType="client"`. Below the
    threshold, items route to a human queue.
  - **Persists every verdict** in a new `moderation_analyses` table (audit trail + AI-flag queue).
  - **Exposes operator-gated review aids** at `/v1/:projectId/moderation/*` — `GET /queue` (AI-flag
    queue), `GET /analysis` (stored verdict for an item), `POST /analyze` (on-demand re-assessment),
    `POST /:id/resolve` (dismiss), `POST /:id/remove` (confirm → remove + clear).
- **API: `POST /internal/moderation/apply`** — a `MODERATION_SERVICE_SECRET`-gated write-back (503
  until configured, mirroring the cron endpoints) that applies an automated decision
  (`moderationStatus` + `moderatedByType="client"`) to an entity/comment. The trust boundary stays
  the API — the moderator never mutates content directly.
- **Schema: `moderation_analyses` table + `moderation_verdict` enum** (`allow`/`block`/`review`),
  migration `0020`. Owned by `apps/api` (single source of truth); the moderator binds a thin copy.
- **Contract: `ModerationVerdict` + `ModerationAnalysis` types and `moderationAnalyzeSchema`** in
  `@agora/contract`, shared by the moderator and admin.
- **Admin: AI moderation surface.** A new **"AI flags"** tab in Moderation (the unresolved
  block/review queue, with per-item **Remove** / **Dismiss**) and an **"AI assessment"** panel in the
  report ReviewDialog (verdict, confidence, categories, rationale, and a **Re-analyze** action),
  backed by `lib/moderation-ai.ts` against `VITE_MODERATOR_BASE_URL` (default `/moderator`, proxied).
- **Per-project moderator integration — admin-configurable.** A new **Settings → Moderator** panel
  configures everything about the `@agora/moderator` service for a project, via
  `GET`/`PATCH /settings/moderator` (`POST …/test` to ping):
  - **Internal notifier** — `projects.moderation_webhook_url` + `moderation_webhook_secret`
    (migration `0021`): a **dedicated** destination + HMAC secret, separate from the (external)
    project webhook. The moderator verifies inbound signatures against `moderation_webhook_secret`,
    falling back to the legacy `webhook_secret` when unset.
  - **Auto-action threshold + LLM tuning** — `projects.moderator_config` JSONB (migration `0022`):
    per-project overrides for `autoActionThreshold` and the LLM provider (`llmProvider`,
    `llmBaseUrl`, `llmApiKey`, `llmModel`, `llmMaxTokens`) that the moderator **overlays on its own
    env defaults** (any unset key falls back to env). The moderator resolves these per assessment
    (`lib/project-config.ts`, cached 30s; `assess()` now takes an explicit `LlmConfig`).
  - Both secrets (notifier secret + LLM API key) are **write-only** — GET exposes only
    `hasSecret` / `hasLlmApiKey`.
  - The panel reads the moderator's `GET /moderation/config` to show the **effective value behind
    each setting** — an "Effective for this project" summary (override ?? server default, with a live
    source badge) and the real default surfaced in every placeholder. So an operator ships sensible
    `.env` defaults and only overrides what a project needs; degrades gracefully if the moderator is
    unreachable.

- **Admin: review AI-flagged content before acting.** The Moderation **AI flags** tab now opens a
  review dialog (like the report flow) instead of blind inline Remove/Dismiss — it loads and shows
  the flagged entity/comment (text + media + author + "Open in app"), the AI verdict (with
  **Re-analyze**), and **Remove** (with an optional human reason that overrides the AI's) / **Dismiss**.
  The report and AI-flag dialogs now share one `ContentPreview`; the moderator's `POST
  /:id/remove` accepts an optional `{ reason }`.
- **Moderator: the LLM score travels into the stored moderation reason.** Write-backs (auto-action
  and human-confirmed removal that falls back to the AI's reason) now format the reason as
  `AI <verdict> (<n>% confidence): <reason>` (`lib/reason.ts`), so the removed content's
  `moderationReason` records *how confidently* and *why*, not just the prose.

### Changed
- **API: structured logging across the business logic.** Beyond the existing per-request log, the
  domain routers + libs now emit `info`/`debug`/`warn` events (data-object-first per wonder-logger;
  ids on everything, never emails/passwords/secrets): auth (signed up/in/out, password change, email
  + external verification), token refresh (rotation `debug`, **reuse-detection `warn`**), webhook
  validation vetoes + broadcast fan-out, content mutations (entity/comment/space create·update·
  delete + reactions), moderation actions (space moderator + operator report resolution + client
  write-back), chat (conversation/message create), search queries, and cron sweeps.
- **Moderator: structured logging across the pipeline.** `info`-level logs for every decision —
  the headline `moderation: verdict` carries `targetId`/`targetType`/`projectId`/`spaceId`, the LLM
  `verdict` + `confidence` (+ `scorePct`), `categories`, `model`, `threshold`, eligibility and LLM
  latency — plus `info` on write-back applied and operator remove/dismiss/analyze actions, and
  `debug` on inbound webhooks, the LLM request/response, write-back attempts, and resolved per-project
  config. Secrets are never logged (data-object-first per wonder-logger).

- **Webhook broadcast fans out to two independent destinations.** `lib/webhooks.ts` `broadcast()`
  now delivers content `*.complete` events to the internal moderation notifier (when configured)
  **regardless of the external webhook's subscribed-events list**, so automated moderation runs even
  with no external integration. The external notifier is unchanged (still gated by its event list).
- **Docs: split the README into a high-level root + per-app guides.** The root `README.md` now
  introduces the project and its packages and links out; each app owns its own setup/config/Docker
  docs in `apps/api/README.md`, `apps/admin/README.md`, and `apps/moderator/README.md`.

## [0.4.0] - 2026-05-31

A security & moderation release: server-enforced **space privacy** (members-only reads) + **posting
permissions**, closed private-content leaks (single reads, reactions, comments, semantic search),
**configurable moderation-removal** visibility (hide / `[removed]`) with read-path enforcement pushed
into the RPCs, and an admin pass — Settings (feed / webhooks / moderation), a richer moderation
review dialog (media + "Open in app" deep links), wonder-logger + OpenTelemetry observability, and a
contributor guide.

### Added
- **Admin moderation — "Open in app" deep link.** The report review dialog now links a moderator
  straight to the reported content in the consumer app: `<VITE_DEMO_URL>?entity=<id>` for an entity,
  `…?entity=<parentEntityId>&comment=<id>` for a comment (the demo reads those params off its URL and
  opens/highlights the target). Defaults to the local demo dev server; set `VITE_DEMO_URL` for prod.
- **Contributor guide + "Contributing" invitation.** A new root `CONTRIBUTING.md` (dev setup, the
  contract rules, coding/security conventions, the migration workflow, testing tiers, changelog
  rule, and Conventional-Commits + PR process) and a `README.md` **Contributing** section that
  welcomes contributors and points at it.
- **Moderation removal now takes effect on reads, with a per-project behavior setting.** Previously
  moderating content as "removed" only stamped `moderationStatus` — no read path honored it, so a
  removed entity/comment kept serving its full content. New `moderation_config.removedContentBehavior`
  (migration `0018`, admin **Settings → Moderation** panel, `GET`/`PATCH /settings/moderation`)
  controls how removed content is served to non-moderators: **hide** (default — filtered out of
  feeds/lists/threads and `404` on single reads) or **placeholder** (the row stays but text/media are
  blanked so clients can show a "[removed]" stub, preserving reply chains). Operators/moderators
  always see removed content for review. Enforced server-side in `lib/moderation-config.ts` +
  `lib/moderation-visibility.ts`, wired into the entity feed/reads and comment list/thread/reads.
- **Admin Settings — Feed ranking panel.** The admin `Settings` section (previously a stub) now hosts
  a live feed-ranking config form wired to `GET`/`PATCH /settings/feed`: default algorithm, decay
  mode, the numeric tunables (half-life / gravity / z / C / m), per-reaction vote weights, the
  per-author diversity cap, and the re-rank webhook. Handles the asymmetric contract (GET nests
  tunables under `params`, PATCH takes them flat; `null` resets a key) and never wipes the write-only
  re-rank secret on save. (`apps/admin` — `lib/settings.ts`, `routes/settings/FeedRankingPanel.tsx`.)
- **Admin Settings — Project webhooks panel.** Second Settings slice, wired to
  `GET`/`PATCH /webhooks/config` + `POST /webhooks/test`: endpoint URL, write-only signing secret
  (kept when left blank), and grouped event subscriptions (validation/blocking vs broadcast/
  fire-and-forget, mirroring the events the server emits) — plus a "Send test ping" button that
  reports the delivery result. (`apps/admin` — `lib/settings.ts`, `routes/settings/WebhooksPanel.tsx`.)
- **Structured logging via `@jenova-marie/wonder-logger`.** A shared Pino logger (`lib/logger.ts`,
  configured by `wonder-logger.yaml`) replaces every `console.*` and the `hono/logger` request
  logger. A `requestLog` middleware emits one structured line per response
  (`method`/`path`/`status`/`durationMs`; `info` <400, `warn` ≥400, `error` ≥500). Console format is
  env-switchable: `LOG_CONSOLE=aligned` (dev default, colorized) / `json` (prod — the Docker image
  sets it). Tunables: `LOG_LEVEL`, `SERVICE_NAME`/`SERVICE_VERSION`; secrets are redacted.
- **OpenTelemetry observability (traces + metrics + log correlation).** `src/instrument.ts` starts
  the OTel SDK (`createTelemetryFromConfig`) as the first import in `index.ts` so auto-instrumentation
  patches HTTP + DB before they load. Configured in `wonder-logger.yaml`: distributed **traces** (OTLP),
  service-level RED **metrics** (Prometheus pull on `:9464` + OTLP push), an OTLP **log** transport,
  and `traceContext` so logs carry `trace_id`/`span_id`. This is the **ops** layer and is deliberately
  separate from `lib/metrics.ts`/`api_usage` (the per-project **product** metering behind the admin
  dashboard, unchanged) — metrics carry no `project_id` label (avoids tenant cardinality). Exporters
  default to a local collector (`OTEL_*_ENDPOINT`); set `OTEL_SDK_DISABLED=true` to turn it all off.
- **Edge rate limiting (env-configured).** An in-memory fixed-window limiter on `/v7/*`
  (`middleware/rate-limit.ts`): `RATE_LIMIT_MAX` caps general per-IP requests per
  `RATE_LIMIT_WINDOW_SECONDS` (default 60); `RATE_LIMIT_AUTH_MAX` applies a stricter cap to `/auth/*`
  (the brute-force target). **Off unless a max is set.** Over-limit → `429 { error,
  code:"common/rate-limited" }` with `Retry-After` + `X-RateLimit-Limit/-Remaining` headers. Client
  IP from `X-Forwarded-For`/`X-Real-IP`; per-process (multi-replica = per-replica). `/health` and the
  `/internal/cron/*` triggers are exempt.
- **Refresh-token cleanup sweep.** `purgeExpiredRefreshTokens()` deletes refresh tokens past their
  TTL so the table doesn't grow unbounded — via the new `POST /internal/cron/purge-tokens`
  (`CRON_SECRET`-gated, like the digest/recompute triggers) or standalone `scripts/purge-tokens.mjs`.
  Keys on `expires_at`, **not** `revoked`: reuse-detection (`lib/tokens.ts`) acts on *unexpired*
  rotated/revoked tokens, so expiry alone bounds growth while preserving that defense.
- **Dashboard metrics endpoint (`GET /v7/:projectId/admin/dashboard/metrics`).** Role-scoped
  aggregate in one round trip: `projectMetrics` (open reports, members, spaces, entities, comments,
  monthly active users, storage-used bytes — live SQL counts) + `appMetrics` (API calls, client
  egress, avg latency — from `api_usage`) + `supabaseMetrics` (whole-instance Postgres size via
  `pg_database_size`, operator-only). Operators see project-wide; moderators see reports scoped to
  spaces they admin/moderate. The admin dashboard renders all three sections live. Supabase egress +
  Auth MAU are intentionally omitted — the Supabase Management API doesn't expose them, so the
  "Supabase usage" section shows only the database-size figure rather than faked placeholders.
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
- **RLS self-access read policies + enablement backstop (migration `0017`).** RLS is defense-in-depth
  (the server connects RLS-bypassing; it remains the trust boundary). Part 1 enables RLS on *every*
  public base table via a dynamic guard, so any future table is deny-all by default. Part 2 adds
  `authenticated`-only SELECT policies that let a signed-in user read only their **own** private
  rows — inbox, collections, connections, linked OAuth identities, filed reports, uploads, space
  memberships, and the conversations/messages/reactions they're a member of. Identity maps Supabase
  `auth.uid()` → Agora profiles through two `SECURITY DEFINER` helpers in a non-exposed `private`
  schema (avoids leaking `profiles`, and dodges self-referential-policy recursion on
  `conversation_members`). No write policies — writes stay server-only. Verified live: own rows
  visible, others' hidden, `profiles` never exposed, anon limited to public content.

### Changed
- **Read-visibility filtering pushed into the set-returning RPCs (was JS post-filtering).** A new
  `space_readable(space, viewer)` SQL predicate, plus visibility params on `fetch_comment_thread`
  (`p_hide_removed`) and `match_content` (`p_viewer`/`p_privileged`/`p_hide_removed`), migration
  `0019`. Two correctness wins: (1) in **hide** mode the comment-thread RPC now prunes a removed
  comment **and its descendant subtree** in the recursive CTE — a JS post-filter only dropped the
  parent and orphaned the replies; (2) semantic search filters private-space/membership/removed
  visibility **inside** `match_content`, so `LIMIT` counts only rows the caller may see (no more
  short result pages from dropping rows after the limit). Removed the now-redundant JS post-filters
  (`readableSpaceIds`, `chat-access.ts`'s `readableMessageIds`). Removed content is always excluded
  from search for non-operators.
- **Moderation review dialog shows the full reported item (media + scroll).** The review modal only
  rendered title + text, so image-only posts (e.g. an uploaded picture) showed "(no text content)"
  and couldn't actually be reviewed. It now renders the entity's images, a comment's gif, and any
  non-image file attachments (as openable links), in a height-capped scrollable body with the
  Dismiss/Keep/Remove actions pinned. (`apps/admin` — `routes/moderation/ReviewDialog.tsx`.)
- **Project-config endpoints accept operators.** `requireProjectAdmin` (gating `/settings/feed` and
  `/webhooks/config`) now passes deployment **operators** (`isOperator`), not only users with
  `profiles.role = 'admin'` — aligning these endpoints with the admin app's operator persona. Error
  code is now the generic `project/not-admin`.

### Fixed
- **Moderation review dialog showed "(no text content)" for comment reports.** `GET /comments/:id`
  wraps its result as `{ comment }` (the SDK contract), but `GET /entities/:id` returns the entity
  bare — and the admin's `getReportTarget` treated both the same, so a reported comment's fields were
  read off the wrapper and came back undefined. It now unwraps the comment response.
- **Private spaces no longer leak to non-members (authorization hole).** A space's
  `readingPermission: "members"` was stored and surfaced (`permissions.canRead`) but never enforced —
  any signed-in (or anonymous) caller could list a private space's entities, read one by id, react to
  it, and comment on it. Added a server-side trust boundary (`lib/space-access.ts`): the feed list
  excludes entities in members-only spaces the caller can't read, single entity/comment reads + the
  comment list/thread + entity/comment reactions throw `403 spaces/members-only`, and comment creation
  is gated on the parent entity's space. The same guard post-filters semantic search (`/content`,
  `/ask`) so private content can't surface via embeddings. Space owners, active members, and
  deployment operators are unaffected; `postingPermission` is enforced separately (next entry).
- **Space `postingPermission` is now enforced on entity creation.** `POST /entities` inserted into
  any `spaceId` without checking the space's posting rule, so a non-member could create entities in a
  `members`- or `admins`-only space. `assertCanPostInSpace` (`lib/space-access.ts`) now gates create:
  `anyone` → any authenticated caller, `members` → active members + owner, `admins` → owner/admin/
  moderator only (operators bypass; project-level/space-less posts are ungated). Mirrors the existing
  chat message-posting gate (`requireMember` + admins-only) and the advisory `permissions.canPost`.
- **Private chat messages no longer leak through semantic search.** Chat messages are indexed for
  search but were hydrated into `/content` + `/ask` results with no membership check — a non-member
  could retrieve private DM/group/space-channel message content by embedding query. Added a
  conversation-membership post-filter (`lib/chat-access.ts`, mirroring the chat REST routes'
  `requireMember`): a message surfaces in search only for an active member of its conversation
  (operators bypass; anonymous callers get no messages, since all chat is membership-gated).
- **Project-level reports are no longer a dead end.** Reports on project-level content (no space)
  showed up in the operator inbox but couldn't be actioned — moderation + resolution run through
  space-scoped endpoints. Added an operator-only `PATCH /reports/:id/resolve` that moderates the
  target (entity/comment) and resolves the report project-wide in one call (`removed`/`approved`/
  `dismiss`). The admin review dialog now enables the actions for operators on project-level reports
  and drops the misleading "resolve it from the space it belongs to" warning.
- **Request-metering flush no longer errors on fractional durations.** `duration_ms_total` is a
  `bigint`, but the accumulator carries sub-millisecond `performance.now()` deltas, so every flush
  hit `invalid input syntax for type bigint`. The total is now `Math.round()`-ed at the DB boundary
  (the in-memory accumulator keeps full precision); negligible for avg-latency. Without this the
  App-metering cards stayed at zero because no window ever committed.
- **Repaired the Drizzle migration snapshot chain so `db:generate` works again.** Snapshots `0011`
  and `0012` shared an identical `id`/`prevId` (a byte-copy collision) and `0013`–`0016` had no
  snapshot files at all, so `drizzle-kit generate`/`check` errored out — which is why migrations
  `0009`–`0016` had to be hand-written. Rebuilt `0012`–`0016` from the live schema with a properly
  chained `id`/`prevId` sequence; all migration SQL is untouched. `check` passes and `generate` now
  reports no drift and emits correct incremental diffs.

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

[Unreleased]: https://github.com/jenova-marie/agora/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/jenova-marie/agora/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/jenova-marie/agora/compare/v0.9.0...v0.9.2
[0.9.0]: https://github.com/jenova-marie/agora/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jenova-marie/agora/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jenova-marie/agora/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jenova-marie/agora/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jenova-marie/agora/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jenova-marie/agora/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jenova-marie/agora/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/jenova-marie/agora/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jenova-marie/agora/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jenova-marie/agora/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jenova-marie/agora/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jenova-marie/agora/releases/tag/v0.1.1
