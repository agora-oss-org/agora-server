# Changelog

All notable changes to Agora are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.19.0] - 2026-07-07

### Fixed
- **Unreachable tenant DB now returns a retryable `503`, not `500`.** When a per-tenant request routes
  to a Postgres DSN that is well-formed but unreachable (host down, connection refused, DNS failure,
  connect timeout, or a dropped socket), the `onError` handler in **both `@agora/api` and
  `@agora/secure-chat`** (which ride the same per-tenant DB seam) now maps the driver's connection error
  to `503 project/db-unavailable` — matching the resolver's own unavailable path and signalling a
  transient infra outage clients can back off and retry. Previously the raw connection error fell through to
  `500 common/internal`, mislabelling a downstream outage as an application bug. The classifier
  (`isDbConnectionError`, `@agora/core/db`) is narrow: only connection/reachability codes map: query and
  constraint errors (e.g. an FK or syntax violation) still surface as `500` so real defects aren't
  masked. Only the driver error `code` is logged (never the DSN, which carries the tenant DB password).
- **Events host/invite `userId` validation.** `POST /events/:id/hosts`, `POST /events/:id/invites`, and
  the `hostIds` on `POST /events` now verify each supplied user is a real profile **in the same project**
  before writing. Previously a non-existent id produced a raw FK `500` and — a cross-tenant hole — a
  profile id from *another* project was silently accepted into the host/invite row. Both now fail closed
  with `400 events/invalid-user` (create validates before the event insert, so a bad `hostIds` no longer
  leaves an orphan event).
- **Events in a soft-deleted space no longer leak on single-GET.** `GET /events/:id` now returns `404`
  for a non-admin when the event's space has been soft-deleted (or is missing), matching how `GET /events`
  already hides it. Previously the list hid the orphaned event while the single fetch still returned it —
  the two paths now agree (fail closed); operators/project-admins still see it to manage cleanup.

### Added
- **`@agora/core/db` resolver seam** — `setDbResolver`/`resolveDbFor` let an external deployment inject a
  per-project DB handle at boot (unregistered → the shared `DATABASE_URL` handle; resolver errors fail
  closed, never a shared-db fallback). Wired at every projectId-known chokepoint: `resolveProject`, socket
  connection-auth, the root-mounted connections routes (via the new access-token `pid` claim +
  `scopeDbToAuthProject`), `/internal/moderation/apply`, the `api_usage` metrics flush, and the
  pending-embeddings drain. Zero behavior change for single-tenant deployments.
- Access tokens now carry a `pid` (projectId) claim, surfaced as `auth.projectId` (`AuthContext.projectId`,
  null on tokens minted before this change).
- **`MAX_POOLS`** env var (default 50): cap on the core db registry's per-DSN connection pools, now
  validated in the env schema (invalid values fail boot instead of silently falling back).
- **Indexes for hot API query paths** (migration `0057`). Four plain btree indexes surfaced by an
  index audit of the API's query paths: `profiles(project_id, auth_user_id)` (resolved on every
  sign-in/sign-up/OAuth callback — previously a seq scan), `profiles(project_id, reputation DESC)`
  (`GET /users/suggestions` ordering), `collection_entities(entity_id)` (the per-entity "is this
  saved?" check, which the PK's leading `collection_id` can't serve), and `refresh_tokens(expires_at)`
  (the purge-tokens cron's `DELETE WHERE expires_at < now()`). Mirrored in the Drizzle schema.
- **Boot hook (`AGORA_BOOT_MODULE`).** Optional module specifier the `agora` and `secure-chat`
  entrypoints side-effect-import once at startup, before serving — lets a prebuilt image register a
  per-project DB resolver (or other init) without editing the bundle. Unset → no-op; a configured module
  that fails to load makes the process fail closed (exit 1). `NODE_OPTIONS=--import` is explicitly not a
  supported mechanism.
- **Mention autocomplete + server-side validation.** `GET /users/suggestions` now honors `query`
  (username/name substring) and returns a bare `User[]`; `GET /spaces` honors its full list surface
  (`searchAny`/`searchName`/`searchSlug`/`searchDescription`, `sortBy`, `memberOf`, `include=files`).
  `mentions[]` on entity/comment/message writes is validated server-side (`lib/mentions.ts`): tokens
  are dropped unless they resolve to a real in-project profile/space, and display fields are refreshed
  to canonical values — closing a cross-tenant mention/notification vector.
- Space-scoped reputation: a trigger-maintained `space_reputation` store (the space-partitioned twin of
  `profiles.reputation`) plus a `loadSpaceReputations` read batcher with recursive-CTE descendant rollup.
  Maintained forward-only; feed-level and message reactions contribute to no space. This is the engine
  behind the SDK v7.8.2 space-reputation enrichment (wire contract owned by that branch).
- **Push-notification preferences.** `GET`/`PUT /push-notifications/preferences` (`{ disabledTypes:
  PushEventType[] }`, full-replace upsert on `PUT`, unknown type → `400`) let a user opt out of
  specific push types over the new 20-value `PUSH_EVENT_TYPES` enum; `dispatchNotificationPush` now
  skips a disabled type before fanning out to devices (migration `0062`,
  `push_notification_preferences` table).
- **Conversation mute.** `POST /chat/conversations/:id/mute` (self only; body `{ duration:
  "8h"|"24h"|"1w"|"forever"|null }`, `null` clears the mute) persists `mutedUntil`/`mutedForever` on
  the caller's own `ConversationMember` row and returns it as `{ currentMember }` (migration `0061`,
  `conversation_members.muted_forever`). A per-conversation push-suppression helper
  (`isConversationMutedForUser`) is implemented in `lib/push/index.ts` but is **not yet wired to any
  call site** — no chat `message` push-dispatch path exists yet, so muting only persists state today;
  wiring the message-push call site is a follow-up.
- **Space visibility.** `visibility: public|unlisted|private` (default `public`) on `POST`/`PATCH
  /spaces`, persisted and emitted on every space response (migration `0060`). **Persist + emit only
  this cycle** — no listing/discovery filtering is applied (an `unlisted`/`private` space is not hidden
  from any list); discoverability filtering is a follow-up.
- **Follows/connections text search.** `?query=&searchFields=username|name` on `GET
  /follows/followers`, `GET /follows/following`, `GET /connections`, and `GET
  /users/:userId/connections` ILIKE-filters the resolved page of profiles. The filter runs **after**
  id-pagination, so `pagination.totalCount` reflects the unfiltered edge/connection count and a
  filtered page can come back shorter than `limit`.
- **Search `includeChildSpaces`.** `POST /search/content` and `POST /search/ask` accept
  `includeChildSpaces?: boolean` — combined with `spaceId`, search scopes to `{self ∪ descendants}` via
  a recursive CTE (`lib/space-tree.ts`) instead of a single space (migration `0063`, `match_content`
  RPC gained `p_space_ids`).
- **User-match request stub.** `POST /match/users` (body `{ mode: passive|directed, query?, ... }` —
  `directed` requires a non-empty `query`, else `400`) validates the request contract and always
  returns `{ results: [] }`, so `useMatchUsers` settles cleanly. The real facet/embedding matching
  engine is unimplemented and is a separate future spec.
- **Space-reputation param validation.** Every user-direct `/users/*` endpoint now validates
  `spaceReputationId: uuid|"none"|"context"` + `spaceReputationDescendants: "true"`
  (`"context"` → `400` on these user-direct endpoints; `spaceReputationDescendants` without an
  explicit uuid → `400`). **Validation only** — no response is enriched with a space-scoped
  reputation value yet; the real tally/rollup + enrichment is a separate future spec.

### Changed
- **Admin: view-only settings banner now reads as a warning.** The "View-only mode — settings changes
  are disabled" notice on Settings uses the warning color + `TriangleAlert` icon (matching the
  unsaved-changes / report-review banners) instead of neutral grey, so the disabled state is obvious.
  (`apps/admin/src/routes/SettingsPage.tsx`.)
- Internal: DB access goes through a request-scoped `getDb()` accessor (AsyncLocalStorage)
  instead of the `db` module singleton, which is no longer exported from `@agora/core/db`.
  Behavior-unchanged groundwork for external per-tenant database routing.
- `AuthContext` (contract) gained `projectId: string | null`; `signAccessToken` (internal) now
  takes `projectId` as its first parameter.

## [0.17.0] - 2026-07-05

### Added
- **Raw classifier signals on moderation analyses.** Every scorer assessment now records the two
  RoBERTa outputs on its `moderation_analyses` row — `toxicity_score` (P(toxic), 0..1) and
  `relationship_score` (signed sentiment, −1..1) — on every verdict including `allow`, and the admin
  AI-flag dialog shows them to human reviewers (migration `0056`, additive contract fields on
  `ModerationAnalysis`). Audit context only — no decision-logic change; the "disagreement routing"
  idea is documented as a future addition in `docs/SCORER.md`.
- **Per-project scorer cascade tuning in the admin.** Settings → Agent moderation now exposes the
  RoBERTa gray-zone gate (`grayzoneLow`/`grayzoneHigh`), the block/review auto-action floors, and the
  co-participates graph bounds (`coParticipatesLookbackDays`/`MaxParticipants`/`MaxWeight`) as
  per-project overrides on `moderator_config` (env values remain the default). Adds a read-only,
  operator-only **Deployment status** view (model-server URLs, queue, poll/visibility, Neo4j, secret
  present/absent). (`packages/contract`, `apps/api/src/routes/misc.ts`, `services/scorer`, `apps/admin`.)
- **Per-project Haiku/LLM adjudication.** The scorer now honors a project's `moderator_config` LLM
  settings — `llmProvider` (`anthropic` or `openai`-compatible), `llmApiKey`, `llmModel`, `llmMaxTokens` —
  falling back to the scorer's env Haiku config per field. A corporate project can bring its own provider
  + key; enablement is per-project (`llm_enabled` = a resolved key exists). (`services/scorer`.)

### Changed
- **The moderator panel's LLM base-url input is removed.** The scorer uses the fixed provider host
  (`api.anthropic.com` / `api.openai.com`); a per-project outbound URL is deliberately not supported
  (SSRF boundary). Provider/key/model/max-tokens stay editable and are now consumed. (`apps/admin`, `services/scorer`.)
- **`docker-publish` now moves `latest` on a manual `workflow_dispatch` run.** Previously the `latest`
  tag (and all version tags) were derived purely from a `v*` tag push, so a hand-triggered rebuild off a
  branch published only a `sha-` tag and never updated `latest`. A temporary `type=raw,value=latest`
  rule (enabled only for `workflow_dispatch`) now republishes `latest` from a manual run. Marked for
  **removal once the team grows past a single trusted maintainer** — it lets any manual run off any
  branch clobber `latest`. (`.github/workflows/docker-publish.yml`.)

### Fixed
- **Native-auth emailed links no longer silently ignore `emailRedirectTo`.** When
  `AUTH_EMAIL_LINK_ALLOWED_ORIGINS` was unset, the link selector fell back to `AUTH_EMAIL_LINK_BASE`
  and dropped the client's requested origin — so a front-end that correctly sent
  `emailRedirectTo: https://demo.example.com` still received a reset/confirm link pointing at the
  default domain. (`lib/auth/email/sender.ts`.)

### Changed
- **Native-auth email now REQUIRES `AUTH_EMAIL_LINK_ALLOWED_ORIGINS`.** Without a configured allowlist
  there is no way to validate a client-supplied `emailRedirectTo`, so the confirm/reset/resend paths now
  **fail closed**: they log a warning and return `503 auth/email-not-configured` (pointing the operator
  at the env var) instead of emailing a link built from an unvalidated value or the possibly-wrong
  default base. The link-base gate is now scoped to providers that build their own links
  (`AuthProvider.usesEmailLinks` — native `true`, Supabase `false`), so Supabase-backed projects — which
  broker their own emails + redirect validation — are unaffected and never hit the new gate.
  (`routes/auth.ts`, `lib/auth/{provider,native-provider,supabase-provider}.ts`,
  `lib/auth/email/sender.ts`.)

## [0.16.5] - 2026-07-04

### Changed
- **`drop`/`genesis` type-to-confirm token now includes the database name** for local targets —
  `localhost:5432/postgres` instead of a bare `localhost:5432` — so the operator disambiguates which
  database on a host that serves several (dev vs test). Supabase targets are unchanged (they confirm
  with the project ref). (`apps/api/scripts/drop.mjs`.)
- **`genesis` now also resets the social graph (Neo4j/DozerDB).** A genesis run rebuilds Postgres
  from nothing, so leaving stale graph edges (`INTERACTED`/`FOLLOWS`/…) behind would desync `/social/*`
  from the freshly-reseeded rows. When `NEO4J_URI` is set, the final step resets the database the app
  reads (`NEO4J_DATABASE ?? "neo4j"`). Strategy is chosen by the database's **role**: a **secondary** db
  gets a true `DROP DATABASE` + `CREATE DATABASE` (from-nothing — also clears constraints/indexes, which
  the scorer recreates on startup); the **default/home** db is emptied in place with `DETACH DELETE`
  (constraints kept), because recreating the home db at runtime on DozerDB strands it in
  `currentStatus:"unknown"` until a server restart. A non-empty graph is **confirmed first** — type the
  `host/db` graph ref (same UX as the Postgres `drop.mjs` gate; Neo4j is a separate datastore, often a
  different host); `--force` skips it, a non-interactive run without `--force` refuses, and declining
  leaves the graph intact. A missing graph db is a clean no-op (the scorer creates it on startup). It is
  **dev-only** (skipped under `--test`, whose env has no dedicated graph) and **best-effort** (a
  down/unreachable Neo4j warns but does not fail the run — the schema rebuild is genesis's core
  contract). Unset `NEO4J_URI` → skipped. (`apps/api/scripts/genesis.mjs`.)
- **`CONTENT_DELETE_MODE` now defaults to `hard`** (was `soft`). Out of the box, deleting an
  entity / comment / chat message / event now truly `DELETE`s the row — FK cascades take dependents
  (a comment's reply subtree, an entity's comments/reactions) — and removes its uploaded media from
  storage, rather than tombstoning the row and leaving the objects orphaned in the bucket. Set
  `CONTENT_DELETE_MODE=soft` to keep the previous recoverable-tombstone behavior. Applied to the
  code default (`packages/core/src/lib/env.ts`), all three `.env.*.example` templates, and the
  `docker-compose.yml` / `docker-compose.prod.yml` interpolation defaults.

### Fixed
- **Admin Community dashboard: Growth (and Moderation-pressure) bar charts rendered empty despite
  showing a non-zero total.** The per-day bars set a *percentage* height (`height: X%`), but their
  flex-column wrappers had no definite height (the row is `items-end`, so columns sized to content
  instead of stretching to the `h-40`/`h-32` row) — so every bar's percentage resolved against a 0px
  parent and collapsed to 0px. The header total still read straight from the data, giving the
  "count shows but chart is blank" symptom. Fixed by giving each column wrapper a definite height
  (`h-full`) in `apps/admin/src/routes/CommunityPage.tsx` (`BarSeries` + `ModerationChart`).

## [0.16.4] - 2026-07-04

### Fixed
- **Logs + traces now report the ACTUAL running version, not a stale `0.14.0`.** The wonder-logger YAML
  hardcoded `version: ${SERVICE_VERSION:-0.14.0}`, and nothing ever set `SERVICE_VERSION`, so every
  service logged `version:"0.14.0"` regardless of the deployed code — a misleading footgun when
  diagnosing "is the new build live?". The version is now injected **programmatically at runtime** from
  `@agora/core`'s `package.json` (`lib/version.ts`, bumped in lockstep with the whole monorepo by
  `scripts/release.sh`) via the new wonder-logger `overrides.version` / `overrides.serviceVersion`
  (requires `@jenova-marie/wonder-logger@^2.1.0`). The `version` line was removed from both
  `wonder-logger.yaml`s — no placeholder to go stale, no `SERVICE_VERSION` env to set.

### Added
- **Per-front-end native-auth email links (`emailRedirectTo`)**: `sign-up`, `request-password-reset`,
  and `send-verification-email` now accept an optional `emailRedirectTo` (client app origin) so a
  multi-front-end deployment (e.g. a marketing site + a demo) sends each user's confirm/reset link back
  to the site they signed up on, instead of one server-wide `AUTH_EMAIL_LINK_BASE`. The requested origin
  is validated against `AUTH_EMAIL_LINK_ALLOWED_ORIGINS`; a non-allowlisted origin 400s
  (`auth/email-redirect-not-allowed`) rather than silently building a link on it (open-redirect guard).
  Omitted, or the allowlist unset, falls back to `AUTH_EMAIL_LINK_BASE` as before. Supabase-backed auth
  ignores the field (Supabase Auth sends its own emails). See `docs/SDK-EMAIL-REDIRECT-TO-SPEC.md` for
  the SDK-side contract this unblocks.
- **`docker-compose.prod.yml` no longer uses `env_file`**: the prod service definitions now enumerate
  every consumed var explicitly via `${VAR:?required}` / `${VAR:-default}` interpolation, so no secret
  has to live in a `.env` file on disk for a prod deploy (values come from the process environment —
  shell export / systemd / Swarm / K8s secret injection). `docker-compose.yml` (selfhost) and
  `docker-compose.dev.yml` are unaffected and still use `env_file: .env`.
- **`/propagate` doc & config propagation system**: `docs/PROPAGATION.yaml` (the map of what
  mirrors what), a `check:propagation` drift-checker CLI in `@agora/api` (`--diff <base>` /
  full-scan, `--json`) that derives typed obligations from the branch diff, and the
  `.claude/skills/propagate` skill that drafts mirror edits (env templates, compose, docs, wiki,
  CHANGELOG) via agent fan-out, propose-then-approve. Surfaced real drift on first run
  (`CONTENT_DELETE_MODE` was missing from `docker-compose.dev.yml`).
- **`CONTENT_DELETE_MODE` (soft|hard) — configurable content-delete semantics** for entities,
  comments, chat messages, and events. `soft` (default, previous behavior): the row is tombstoned
  (`deleted_at`/`user_deleted_at`), hidden from reads, and its media stays in storage (recoverable).
  `hard`: the row is truly `DELETE`d — FK cascades take dependents (an entity's comments/reactions,
  a comment's reply subtree) — **and the uploaded media is removed from storage** (MinIO/S3 via
  `DeleteObjects`, Supabase Storage via `remove`); previously deleted posts orphaned their images in
  the bucket forever. Object keys are collected before the row delete (`lib/storage-cleanup.ts` —
  an entity gathers its comments' files, a comment its whole reply subtree via recursive CTE) and
  removed async best-effort (a storage failure logs and never fails the request). Moderation
  removal and account deletion are deliberately unaffected. New `StorageProvider.remove(keys)` on
  the storage seam; knob documented in all three `.env.*.example` templates.
- **Postmark transactional-email transport for native auth.** Native-auth confirmation, password-reset,
  and account-deletion emails are now actually *sent* when Postmark is configured — previously the only
  `EmailSender` was the dev `ConsoleEmailSender`, which merely logged the confirm link (so a native-auth
  deploy reported "confirmation email dispatched" but delivered nothing). New `PostmarkEmailSender`
  (`apps/api/src/lib/auth/email/postmark.ts`) posts to Postmark's `/email` API; `resolveEmailSender()`
  selects it when `POSTMARK_SERVER_TOKEN` is set, else falls back to the console stub. All Postmark
  values are env-driven: `POSTMARK_SERVER_TOKEN`, `AUTH_EMAIL_FROM` (default `noreply@agora-oss.org`,
  must be a Postmark-verified sender), `POSTMARK_MESSAGE_STREAM` (default `outbound`), `POSTMARK_API_BASE`,
  and `AUTH_EMAIL_LINK_BASE` (front-end origin for the emailed links; now validated in the env schema
  instead of read ad hoc). Documented in all three `.env.*.example` templates and `docs/SELF-HOSTING.md`.
  Supabase-backed projects are unaffected (Supabase Auth sends its own emails).
- **Per-front-end email links for native auth (multi-front-end deploys).** Sign-up, password-reset, and
  resend-confirmation requests accept an optional `emailRedirectTo` (the client's app origin), so a
  deployment with several front-ends (e.g. `agora-oss.org` + `demo.agora-oss.org`) sends each user a link
  back to the site they signed up on. **Security:** the server only builds links to an origin on the new
  `AUTH_EMAIL_LINK_ALLOWED_ORIGINS` allowlist and rejects a non-allowlisted `emailRedirectTo` with `400`
  `auth/email-redirect-not-allowed` (open-redirect / phishing guard — a client-supplied link base is never
  trusted unvalidated). Allowlist unset → feature off, links always use `AUTH_EMAIL_LINK_BASE`. Contract
  change: optional `emailRedirectTo` on `signUpSchema`/`emailSchema` (Supabase-backed auth ignores it).

### Changed
- **`MINIO_UPSTREAM` is now env-configurable in `docker-compose.prod.yml`**
  (`${MINIO_UPSTREAM:-http://minio:9000}`, previously hardcoded) and documented in
  `.env.prod.example`. Needed when MinIO runs outside the compose stack (external/swarm service
  name). The template warns it must be a **directly reachable container address**, never another
  reverse proxy's public hostname: Caddy's `reverse_proxy` forwards the original client `Host`
  header, so routing `/media` back through an outer front door matches the wrong vhost, whose
  auto-HTTPS 308 ultimately serves the SPA's `index.html` as the "image" — a silent broken-image
  failure with no console error.

## [0.16.3] - 2026-07-03

### Added
- **`scripts/bootstrap-supabase-compat.sql` — one-time Supabase-compat bootstrap for a VANILLA
  Postgres deploy** (e.g. `postgres:bookworm`, not the `supabase/postgres` image). The migrations
  assume the Supabase-managed `anon`/`authenticated`/`service_role` roles and an `auth` schema with
  `auth.uid()` already exist (`0008`/`0017` grant to them; `0017`'s RLS policies call `auth.uid()`);
  on a plain Postgres they don't, so `genesis`/`drop` die with `role "anon" does not exist`. Run this
  once as a superuser before `genesis.mjs` to provision them (idempotent, survives `genesis` re-runs).
  None of it is load-bearing — the server connects as the owner role and bypasses RLS — but the DDL
  must still execute without erroring.

### Changed
- **`genesis.mjs` now prints the resolved DB target before it does anything destructive.** The header
  shows `host:port/dbname` (credentials stripped — never printed) plus `AGORA_ENV`, so the operator
  can confirm exactly which database is about to be dropped and rebuilt before the drop runs.
- **README: the social graph (Garden) is labelled `alpha`.** The layer is functional and off by
  default, but its APIs/scoring/admin surfaces are still evolving; everything below it stays beta/stable.

### Fixed
- **`docker-publish.yml` image matrix reordered** so `agora-proxy` builds after `agora-secure-chat`.

## [0.16.2] - 2026-07-02

### Fixed
- **The admin Social tab (and Settings read-only mode) can now actually be enabled in published
  images.** `VITE_SOCIAL_GRAPH_ENABLED` / `VITE_SETTINGS_READ_ONLY` are Vite build-time flags baked
  into the admin SPA, but `deploy/proxy/Dockerfile` only declared `ARG VITE_API_BASE_URL` and the
  `docker-publish.yml` build step passed **no** `build-args`, so the flags were always compiled off
  regardless of any runtime env — the Social tab could never appear in a pulled `agora-proxy` image.
  The Dockerfile now declares both flags as build args (empty default = off) and the publish workflow
  forwards them from repo/environment Variables (`vars.VITE_SOCIAL_GRAPH_ENABLED` /
  `vars.VITE_SETTINGS_READ_ONLY`). Set the repo Variable to `true` and rebuild/republish the proxy
  image to surface the Social tab (still operator-gated + requires `NEO4J_URI` on the API).

## [0.16.1] - 2026-07-02

### Added
- **Grafana is reachable through the Caddy front door at `/grafana/`.** The proxy now routes
  `/grafana/*` (and redirects the bare `/grafana`) to the observability Grafana, gated behind the
  `observability` profile like the other lazy upstreams (502s until it's up). Added to both routing
  snippets (`agora-routes.caddy`, `agora-routes.dev.caddy`) and the `GRAFANA_UPSTREAM` env on all three
  compose files' `proxy` service; Grafana runs with `serve_from_sub_path` + a matching `GF_SERVER_ROOT_URL`
  so its asset/redirect URLs carry the prefix. **Security posture differs by environment:** in prod
  (`docker-compose.prod.yml`) anonymous access is DISABLED and a login is required
  (`GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD`, documented in `.env.prod.example` — change the
  placeholder), and Grafana's public `:3000` host port is dropped (reached only via `/grafana/`); dev keeps
  the anonymous-admin convenience and the direct `:3000` port on localhost. For the same reason the
  prod `alloy` service no longer publishes its unauthenticated `:12345` UI port either — it stays internal
  (tunnel in if needed); dev keeps it.
- **Admin Settings warn before you lose unsaved edits.** Each Settings form (Feed ranking, Moderator,
  Webhooks, Social graph) now tracks whether it has unsaved changes and, when it does, shows a sticky
  banner — "You have unsaved changes — save before navigating away" — so operators don't silently lose
  edits by switching tabs or leaving the page. The banner is informational only (it points to the form's
  own Save button, not a duplicate) so it can never imply it saves more than the one section. Write-only
  secrets (webhook/re-rank signing secret, LLM API key) only trip the banner when actually re-entered.
  (The Stewardship tab saves each choice immediately and has no form state, so it has no banner.)

### Changed
- **Admin login no longer asks for a Project ID.** The admin resolves its project automatically, so the
  login form's Project ID field is removed and sign-in uses that project directly.

### Fixed
- **`docker-compose.prod.yml` had drifted behind `docker-compose.yml`.** Several dev-compose additions
  were never backported to the prod (pulled-image) file, so a prod deploy silently lost them. Reconciled
  so the only intended differences are prod's hardening (pulled images, no published backend ports, baked
  proxy config): restored the OpenTelemetry env wiring on every instrumented service (`agora`,
  `secure-chat`, `scorer-toxicity`, `scorer-relationship`, `scorer-worker`); restored `secure-chat`'s
  whole `environment` block — including the `SERVICE_NAME` override that stops `env_file` from making it
  report under the API's identity in Grafana; restored the `--profile demo` service (+ the proxy's
  `DEMO_UPSTREAM`); restored the `--profile observability` stack (Alloy/Tempo/Mimir/Loki/Grafana) and its
  five volumes; and restored the `neo4j` `NEO4J_DATABASE` default-database fallback. Header/profile-list
  and deploy-bundle notes updated to match.
- **`docker-compose.yml`'s `demo` service dropped the Umami analytics vars.** The service correctly
  omits `env_file` (the arms-length demo image must never see `DATABASE_URL` / the token secrets), but
  that means only explicitly-listed vars reach it — and `AGORA_DEMO_UMAMI_URL` / `AGORA_DEMO_UMAMI_ID`
  (set in `.env.selfhost.example` for the demo) weren't forwarded, so setting them did nothing. The
  service now forwards the full `AGORA_DEMO_*` runtime set the published image's entrypoint reads
  (adds the two Umami vars + `AGORA_DEMO_SECURE_CHAT_DEBUG`), matching the `agora-demo` repo's own
  compose.
- **`http://<host>/demo` (no trailing slash) 404'd behind the Caddy front door.** `handle_path /demo/*`
  only matches the trailing-slash form, so the bare path fell through to the catch-all SPA handler.
  `deploy/proxy/agora-routes.caddy` now redirects the bare `/demo` to `/demo/` (308) before that
  handler runs.
- **`docker-compose.yml`'s demo-seeding instructions pointed at nonexistent scripts and the wrong
  email.** The comment above the `demo` service referenced `scripts/seeds/seed-native-admin.mjs` /
  `seed-demo-user.mjs` (neither exists — the real entry point is `00-seed-auth-admin.mjs`) and told
  self-hosters to seed `agora-admin@gmail.com`, while `docs/SELF-HOSTING.md` separately asserted the
  demo signs in as `agora-demo@gmail.com` — neither matched the demo's now-runtime-retargeted
  `AGORA_DEMO_EMAIL`/`AGORA_DEMO_PASSWORD` (defaulted here to `agora-admin@gmail.com`, matching
  `00-seed-auth-admin.mjs`'s own default), so following either doc left the demo's pre-filled login
  401ing. Both docs now agree, and `.env.selfhost.example`'s `AGORA_DEMO_UMAMI_URLL` typo (extra `L`,
  didn't match the entrypoint's actual `AGORA_DEMO_UMAMI_URL`) is fixed.
- **Demo seed image posts 500'd on a self-hosted prod deploy.** The 13 `seed-*-post.mjs` fixtures (and
  the `02-download-images.mjs` cache step) downloaded Pexels images to
  `apps/api/scripts/seeds/images/` on disk, but the prod image's `COPY --from=builder /out ./` runs as
  root before `USER node`, leaving `/app` root-owned — the non-root runtime user got `EACCES` trying to
  `mkdir` the cache dir. Rather than widen the shipped image's writable surface, the seed images are now
  fetched **in-memory per seeder run** (new `scripts/seeds/lib/seed-images.mjs`, `fetchSeedImageBytes()`)
  and never touch disk; `02-download-images.mjs` and the on-disk cache are removed entirely. Each
  seeder's per-image URL override (`<NAME>_IMAGE_URL`) now actually works — it was documented but
  previously dead code (the scripts only read a `_IMAGE_PATH` file-path override).

### Changed
- **`03-seed-engine.mjs` now seeds `follows` before `posts`.** Order is
  `users → spaces → memberships → follows → posts → comments → connections → reactions` (previously
  `follows` ran after `comments`). A post's seeded followers now already follow its author by the time
  the post is created, so follow-driven notification/feed fan-out reflects the relationship instead of
  the post predating it.

## [0.16.0] - 2026-07-01

### Added
- **Local-Postgres-first configuration: one dual-mode env template per compose file + a destructive-script
  guardrail.** Agora now defaults to a **local Postgres (the `supabase/postgres` image) + MinIO** — no cloud
  account required; cloud Supabase is an opt-in in-file switch. There's one authoritative template per
  compose file: **`.env.dev.example`** (`docker-compose.dev.yml`, host app), **`.env.selfhost.example`**
  (`docker-compose.yml`, container from source), **`.env.prod.example`** (`docker-compose.prod.yml`, pulled
  image). Each **defaults to local PG + native auth** and carries the full cloud-Supabase block commented
  inline (comment LOCAL / uncomment CLOUD, run `--profile supabase`). Every template carries an
  **`AGORA_ENV`** marker (`dev`/`selfhost`/`prod`). `scripts/drop.mjs` / `scripts/genesis.mjs` gate a
  destructive `--force` on the **`DATABASE_URL` host + `AGORA_ENV`**: a LOCAL throwaway (`db`/`localhost`,
  non-`prod`) drops unattended, while a **PROTECTED** target — any cloud/remote host, **or**
  `AGORA_ENV=prod` even on a local db — requires typing the project ref (`--force` won't skip it; the only
  non-interactive exception is `genesis --test` on the disposable test DB). Self-host was validated
  end-to-end (boot → genesis → native admin seed → login → MinIO media). New pure helper
  `apps/api/scripts/lib/db-target.mjs` (`dbTargetHost`/`isLocalHost`/`isProtectedTarget`, unit-tested). Docs
  (README, SELF-HOSTING, DEVELOPMENT, CHEAT-SHEET, CONTRIBUTING, CLAUDE.md, wiki) describe the local-first,
  one-template-per-compose-file model.
- **Adaptive, overridable Constellation k-anonymity floor + on-demand recompute.** The Constellation's
  cluster-suppression floor (`constellationKFloor`) is now **adaptive by default**. When a project leaves it
  unset (`null`), the materializer derives it from project size via `adaptiveConstellationFloor(N)`
  (`N<50→2`, `<100→3`, `<500→4`, `≥500→5`), so a small community (e.g. a dozen members) finally renders its
  real shape instead of an always-empty "forming" snapshot, while large communities keep the
  privacy-meaningful floor of 5. A project may still pin an explicit floor, now `2–1000` — the **hard
  anonymity floor is 2** (a blob always represents ≥2 people, so it can never *be* one identifiable person).
  New **`POST /v7/:projectId/admin/social/constellation/recompute`** (project-admin-gated) force-rematerializes
  the snapshot on demand (synchronous GDS Louvain; same gate order as the Garden reads — config `400
  social/constellation-disabled` → infra `503 social/graph-unavailable`) and returns the fresh snapshot.

- **On-demand community-stats compute button.** The admin Community dashboard's empty state (no rollup
  has run yet) previously just printed shell-command instructions. New **`POST
  /v7/:projectId/admin/community/recompute`** (project-admin-gated) runs the same rollup as the
  `community-stats` cron, scoped to the current project, so the empty state now offers a "Compute now"
  button instead.

### Changed
- **`@agora-server/contract` 0.15.2 → 0.16.0.** `ResolvedSocialConfig.constellationKFloor` widened
  `number → number | null` (`null` = adaptive); `COMMUNITY_DEFAULTS.constellationKFloor` is now `null`; the
  `socialConfigSchema` write bound relaxed `min(5) → min(2)`; the read resolver now maps a malformed /
  out-of-`[1,1000]` / absent value to `null` (adaptive) and raises a stored value to `≥2`. New exported pure
  helper `adaptiveConstellationFloor(memberCount)`. The admin **Settings → Social** k-floor control is now an
  **Adaptive (recommended)** / **Fixed floor** selector (adaptive shows the size→floor tier table; fixed takes an
  explicit `2–1000`), plus a **"Recompute constellation now"** button that force-rematerializes the snapshot.

### Removed
- The stale env examples superseded by the per-mode templates above: the repo-root `.env.example`
  (a 15-var stub that covered only compose interpolation + OTEL) and `apps/api/.env.example` (a stale
  Supabase direct-connection shape). The `.gitignore` now tracks any `.env.*.example` via one pattern.

### Fixed
- **Scorer `Failed to export metrics batch code: 404` log spam eliminated.** `services/scorer/scorer/telemetry.py`
  no longer pushes metrics via OTLP — Alloy's OTLP receiver intentionally drops that signal (see
  `deploy/observability/config.alloy`), so every export attempt 404'd forever. Metrics are now exposed on
  `:9464` via `PrometheusMetricReader`, the same scrape pattern the Node apps already use;
  `config.alloy` gained a `prometheus.scrape "agora_scorer"` job for the worker + 2 model servers, giving
  the scorer real metrics in Grafana/Mimir for the first time (previously it contributed traces + logs
  only). Traces are unaffected (still OTLP push to Tempo). New dep: `opentelemetry-exporter-prometheus`.
- Logging hygiene: `closeMediationForCase`'s catch put a raw `{ err }` on an **`error`**-level log
  (`lib/mediation.ts`) — the only such site in the codebase. Split to a message-only `error` plus a
  `debug({ err })` companion per the Log-with-intent policy, so exception detail (a potential
  secret/PII carrier) no longer ships to aggregators at `error` level.
- Chat: `message:created` now fans out to every member's user room (inbox observers update without joining the thread room), not only the conversation room.
- **Events domain hardening — visibility, capacity, and input robustness.** `GET /events` now applies
  the **space-read** gate to *every* visibility (not just `public`), so the list can no longer surface an
  `invite`/`members` event living in a members-reading space that single-GET would `403` — list and
  single-GET stay consistent and fail closed. RSVP `going` capacity is enforced inside a row-locked
  transaction (`select … for update` on the event), closing a read-then-insert **TOCTOU** that could let
  concurrent RSVPs overshoot `capacity`. Unknown enum query filters (`GET /events` `?type`/`?status`,
  `GET /events/:eventId/rsvps` `?status`) now return a clean `400 events/invalid-filter` instead of a
  Postgres invalid-enum `500`. PATCH `removeImageIds` now clears `events.cover_image_id` when the removed
  file was the cover (no dangling pointer). (RSVP set/withdraw and the guest-list read already require
  event-view access — `403 events/not-visible`.)
- **Social analytics no longer warns when the graph is empty.** `withProjectedGdsGraph`
  (`apps/api/src/lib/social-gds.ts`) now returns early for an empty candidate set and pre-counts
  matching `:User` nodes before projecting, degrading to `null` with a single `debug` line instead of
  letting `gds.graph.project.cypher` throw `Node-Query returned no nodes`. Before the scorer has
  projected any nodes/edges that exception surfaced as a `WARN`+stack on every
  `/admin/social/recompute`; genuine GDS failures still warn.
- **Scorer Neo4j startup no longer fails for a hyphenated `NEO4J_DATABASE`.** `ensure_constraints`
  now backtick-quotes the database name in the `CREATE DATABASE` DDL (`services/scorer/scorer/neo4j.py`),
  so a name like `agora-graph` parses in Cypher instead of erroring with
  `Invalid input '-': expected ... 'IF NOT EXISTS'` and giving up on constraint setup. The regex name
  guard already rejects backticks, so quoting stays injection-safe.
- **Scorer `consumer poll failed` now logs its cause at `debug`.** The pgmq poll-loop catch was
  message-only with no `debug` companion, making a repeating poll failure undiagnosable; it now emits
  `repr(exc)` + traceback at `debug` (per the Log-with-intent convention), so `LOG_LEVEL=debug` reveals
  why (e.g. a missing `pgmq.scorer_jobs` queue or an unreachable `DATABASE_URL`).

### Changed
- Chat: `GET /chat/conversations` now returns the `ConversationPreview` shape (`otherMembers`, `lastMessage` truncated to 100 chars).
- Connections: request/accept notifications now route through the shared notification pipeline, so they fan out over `notification:created` (realtime) and the push webhook — previously inserted silently.
- **Caddy front door defaults to the Let's Encrypt *staging* ACME CA.** New `acme_ca` global option in
  `deploy/proxy/Caddyfile` (driven by the `ACME_CA` env, threaded through the `proxy` service in both
  `docker-compose.yml` and `docker-compose.prod.yml`) so a first-time real-domain deploy validates DNS +
  firewall reachability without
  burning the strict production rate limits. Staging certs are browser-untrusted (expected while testing);
  set `ACME_CA=https://acme-v02.api.letsencrypt.org/directory` for real certs before going live. Only
  affects a real-domain `SERVER_NAME` — `localhost` (internal CA) and `:80` (plain HTTP) never touch ACME.
  Documented in `deploy/proxy/README.md`, `docs/SELF-HOSTING.md`, and `.env.example`.

### Added
- Push notifications: `push_devices` table + `/v7/:projectId/push-notifications/*` (register/deregister/deregister-fallback/vapid-public-key).
- Push dispatch seam (Web Push fully wired; FCM HTTP v1 + APNs HTTP/2 credential-gated) bridged to the in-app notification choke point.
- VAPID per-project (project_integrations `vapid`) with `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` env fallback.
- Chat: `GET /chat/conversations/:id/preview` (single `ConversationPreview` — `unreadCount`, `otherMembers`, truncated `lastMessage`).
- Chat: `conversation:created` socket event fanned to member user rooms on new direct/group conversations.
- Chat: `?after=<ISO>` cursor on `GET /chat/conversations/:id/messages` for reconnect catch-up (ascending, strictly after the cursor; `400 chat/invalid-after` on a malformed timestamp).
- DB: `conversations_keyset_idx` for inbox keyset pagination.
- **Events domain — community events with RSVPs, invites, and co-hosts.** New `events` /
  `event_rsvps` / `event_invites` / `event_hosts` tables (+ `files.event_id` so cover/gallery images
  link to an event) and the `/v7/:projectId/events/*` REST surface (14 endpoints): CRUD + `cancel`,
  RSVP set/withdraw/list (capacity + `allowMaybe` + closed-event gates), invites (host-only,
  idempotent; removing an invite also drops the RSVP), and co-host add/remove (last-host guard). Event
  visibility is `public | members | invite` (per-row gated on read; the list shows public + the
  caller's own visible set), removed events are hidden from non-admins, and a PostGIS `location` powers
  `locationFilters` radius (km) list filtering. Cover + gallery images go through the existing image
  pipeline. New `@agora-server/contract` `Event` / `EventRsvp` / `EventInvite` types + `createEvent` /
  `updateEvent` / `rsvp` request schemas. Documented in `docs/MODELS.md` + `docs/MANIFEST.md` (🔶
  inferred — SDK-derived, not yet round-tripped against the live SDK).
- **`docker-compose.dev.yml` `--profile neo4j` starts just the graph DB.** Added `neo4j` to the neo4j
  service's profile list so `docker compose -f docker-compose.dev.yml --profile neo4j up` brings up
  Neo4j alone (no scorer model servers or LGTM stack) — for graph dev or exercising the API's
  `/social/*` reads against a live graph without the full scorer fleet's memory footprint.
- **`docs/DEVELOPMENT.md` — single developer guide (develop · debug · research · test).**
  Consolidates the dev-loop material that was scattered across `CONTRIBUTING.md`,
  `apps/api/README.md`, and `docs/CHEAT-SHEET.md` into one page: prerequisites/build, the **three local
  run modes** (all-host `pnpm dev`, all-containers `docker-compose.yml`, the hybrid
  `docker-compose.dev.yml`), seeding, the develop loop, debugging (log levels, test-JWT minting, the
  secure-chat log correlator), researching the codebase, the two-tier test suite (+ the
  integration-filter and `TMPDIR`/`ENOSPC` gotchas and the `db:migrate:run` foot-gun), and commit/PR
  conventions. Linked from `README.md` and `CONTRIBUTING.md § Dev setup`.
- **`docker-compose.dev.yml` — local dev compose that runs the three app surfaces on the host.** A
  standalone compose (`docker compose -f docker-compose.dev.yml --profile selfhost --profile full up`)
  that brings up the backing services + supporting containers (Caddy front door, `cron`, the Python
  scorer + model servers, Postgres/MinIO/Redis/Neo4j) but **omits** the `agora` API and `secure-chat`
  containers — you run those plus the admin SPA as host `pnpm dev` (tsx/vite HMR). Mirrors the same
  two-axis profile vocabulary as `docker-compose.yml`/`.prod` (`supabase`/`selfhost`, `scorer`,
  `secure-chat`, `scale`, `full`, `demo`, `observability`). Every container that calls the app is
  repointed at the host: the Caddy upstreams (`API_UPSTREAM`/`SECURE_CHAT_UPSTREAM`/new `ADMIN_UPSTREAM`),
  the scorer's `API_BASE_URL`, and cron's `AGORA_URL`/`SECURE_CHAT_URL` all default to
  `host.docker.internal` (with `extra_hosts: host-gateway` for Linux parity), and backing ports
  (`redis:6379`, `db:5432`, `minio:9000/9001`, `neo4j:7474/7687`, Alloy OTLP `:4318`) are published so
  host processes reach them at `localhost`. The one container that also needs the DB (`scorer-worker`)
  reaches the API + Neo4j at fixed in-network addresses (`host.docker.internal:4000`, `neo4j:7687`) and
  uses the standard `DATABASE_URL` — on `supabase` the cloud URL works from the container as-is; on
  `selfhost`, set `DEV_DATABASE_URL=…@db:5432/postgres` (mirrors `TEST_DATABASE_URL`; falls back to
  `DATABASE_URL` when unset) since the host's `localhost:5432` won't reach the db from inside a container.
  Ships a dev Caddy routing snippet `deploy/proxy/agora-routes.dev.caddy` (mounted over the
  baked one) whose SPA catch-all reverse-proxies the admin root to the host vite server (live HMR
  through the front door) instead of the baked static build. Isolated compose project name `agora-dev`
  so it never collides with a `docker-compose.yml` stack.
- **CI: automatic GitHub Releases from CHANGELOG.md.** A new `release.yml` workflow fires on the same
  `v*` version tag as `docker-publish` / `npm-publish` and creates (or, on a re-pushed tag, updates) a
  GitHub Release whose notes are the CHANGELOG section for that exact version — the body between
  `## [x.y.z] - DATE` and the next `## [` heading, extracted with `awk` and published via the `gh` CLI
  (built-in `GITHUB_TOKEN`, `contents: write`). SemVer prereleases (a `-` suffix, e.g. `v0.16.0-rc.1`)
  are flagged as prereleases; a tag with no CHANGELOG section still releases with a fallback pointer.
- Entity feed: first-class `createdAt` sort (honors `sortDir`); `new` kept as a deprecated alias.
- Comment list: `createdAt` and `controversial` sorts; `sortDir` honored for `createdAt`.
- RFC 8594 `Deprecation` header on `?sortBy=new` (entities) and `?sortBy=new|old` (comments).
- `@agora-server/contract`: `commentSortBySchema` + `sortDirSchema`.

## [0.15.2] - 2026-06-28

### Changed
- **CI: image build cache moved from the GitHub Actions cache backend to a GHCR registry cache.**
  `docker-publish.yml`'s per-arch `build` job now uses `cache-to`/`cache-from`
  `type=registry` (a `:buildcache-<arch>` tag per image) instead of `type=gha`. The Actions cache
  backend throttled and evicted (10 GB cap) the large `torch`/`transformers` layers in
  `agora-scorer-model-server`, so `mode=max` cache export dominated build wall-clock (~13 min).
  Registry cache has far higher throughput and no eviction churn, cutting warm-cache build time.

## [0.15.0] - 2026-06-28

### Added
- **Realtime app-notifications over socket.io.** A new server→client `notification:created` event
  (payload = the full shaped notification row) fans out to a per-user room
  `user:<projectId>:<userId>` that every authenticated socket **auto-joins** on connect, so the
  bell/badge updates live for **every** notification type (comment/reply/mention, follows,
  reactions, steward, …) — not just on the next REST poll. Emitted from the shared notification
  `insert()` choke point. Optional **cross-replica fan-out** via `@socket.io/redis-adapter`, enabled
  when `REDIS_URL` is set (also makes existing chat fan-out cross-replica); fail-soft to
  single-process when unset.

### Changed
- **A comment reply now also notifies the entity owner.** A reply generates an `entity-comment` to
  the entity owner **in addition to** the `comment-reply` to the parent comment's author, deduped
  when they are the same user (one row, the `comment-reply`) and skipping self-notification.
- **Seed scripts restructured into a one-prompt admin master + a demo-data gate.** The two
  backend-specific admin seeders (`seed-demo-user.mjs` / `seed-native-admin.mjs`) are replaced by a
  single entry point, **`scripts/seeds/00-seed-auth-admin.mjs`**, which prompts once for an admin
  email + password and drives both backends in `scripts/seeds/helpers/` (`seed-native-auth-admin.mjs`
  → in-API argon2 `auth_credentials`; `seed-supabase-auth-admin.mjs` → confirmed Supabase user). Each
  helper **self-gates on `projects.auth_provider`** — the active backend is seeded, the other prints a
  one-line skip — so a run no longer hangs on a prompt for, or writes dead data into, the inactive
  backend. A new gate, **`01-confirm-demo-data.mjs`**, asks whether to seed the demo CONTENT and, on
  "no", exits with a sentinel code (78) that the `seed.mjs` orchestrator recognizes as a **clean stop**
  (remaining content seeders skipped, not failed); `SEED_DEMO_DATA=1|0` overrides for CI. The
  orchestrator's fatal-abort match now covers the renamed admin seeder, and the (now non-excluded)
  `03-seed-engine.mjs` runs as part of `pnpm seed` (gated by the opt-in) — it remains **not
  idempotent** (re-running duplicates its graph world). Docs (`SELF-HOSTING`, `CHEAT-SHEET`, `SCORER`,
  `CLAUDE.md`, admin `config.ts`) and every post-seeder's bootstrap pointer updated to the new names.

### Added
- **`createIfNotFound` on `GET /entities/by-foreign-id`.** The SDK's `EntityProvider` /
  `CommentSection` pass `createIfNotFound=true` to lazily materialize the social-layer anchor for
  external content (a blog post/product whose canonical record lives in the host app's own DB) the
  first time it's viewed — previously the server only ever 404'd, so comment/reaction widgets mounted
  on a never-seen `foreignId` stayed broken. The created entity is **authorless** (`userId` null): it
  proxies host-app content, so the first viewer must not become its owner. Creation is race-safe under
  concurrent first-views via the `(project_id, foreign_id)` unique constraint (the insert loser
  re-selects the winner's row), idempotent, and project-scoped. Public path (no auth required, matching
  the anonymous-widget contract); edge rate limiting bounds abuse. New pure helper `parseBoolFlag`
  (`lib/shape.ts`, unit-tested) + integration coverage in `test/integration/entities.test.ts`.
- **`--profile demo` — one-command demo app for self-host evaluators.** A new optional compose profile
  pulls the prebuilt SDK-compatibility harness (`../agora-demo`) and serves it behind the Caddy front
  door at **`/demo/`**, same-origin with the API at `/v7` (no CORS; chat sockets reuse the existing
  routing). `docker compose --profile selfhost --profile demo up` → the demo at `http://localhost/demo/`,
  auto-wired to the local API. New Caddy route (`handle_path /demo/*` in `deploy/proxy/agora-routes.caddy`),
  `DEMO_UPSTREAM` on the proxy, and `AGORA_DEMO_API_BASE_URL` / `AGORA_DEMO_PROJECT_ID` / `AGORA_DEMO_IMAGE`
  env (documented in `.env.example` + `docs/SELF-HOSTING.md`). The image is **pulled, never built here**
  (the demo stays an arms-length consumer of the published SDK). Companion changes in the `agora-demo`
  repo make one published image retargetable at any API at container start (runtime `/config.js` +
  relative Vite base), so the same artifact serves the public demo and a local self-host.

## [0.14.0] - 2026-06-27

### Removed
- **Umami analytics — removed entirely.** The server no longer sends product-usage events to an
  external analytics service. Deleted the API send/reporting (`lib/umami.ts`, `lib/umami-reporting.ts`)
  and all `trackEvent` call sites, the operator-only `GET /admin/umami/overview` endpoint, the admin
  **Analytics** page + nav entry + browser tracking (`lib/analytics.ts`, the `vite.config` script
  injection, all `track()` calls), and every `AGORA_UMAMI_*` env var. Product metering (`api_usage`)
  and ops telemetry (OTel) are unaffected.

### Added
- **Full OpenTelemetry across every service + a bundled Grafana collection stack.** Telemetry is now
  built into all of Agora, not just the API:
  - **`@agora/secure-chat`** gets its own OTel SDK (`src/instrument.ts`, first import in `index.ts`) so
    it emits traces + metrics + a Prometheus `:9464`, labelled distinctly as `agora-secure-chat`. Both
    Node apps now share one telemetry config via the new `@agora/core/lib/wonder-logger-config` export.
  - **`@agora/api`** gains custom ops instruments (`lib/telemetry.ts`): embedding latency/outcome,
    automated-moderation decisions, feed-algorithm mix, and live socket.io connections/events — plus
    spans around the realtime path (previously invisible to HTTP auto-instrumentation). No-op-safe when
    telemetry is off.
  - **`services/scorer`** (Python) gets an OTel bootstrap (`scorer/telemetry.py`) auto-instrumenting
    FastAPI + asyncpg + httpx, and `trace_id`/`span_id` injected into its JSON logs for trace↔log
    correlation, matching the Node side.
  - **`observability` compose profile** — a one-command **Grafana Alloy → Tempo/Mimir/Loki/Grafana**
    stack (`deploy/observability/`), with the apps' OTLP endpoints pre-wired to Alloy. Telemetry stays
    **off by default** (bare deploys are dark, no export warnings); `OTEL_SDK_DISABLED=false` is the
    single on-switch. Traces + logs flow via OTLP; **metrics are scraped** from the Node `:9464`
    endpoints and remote-written to Mimir (deterministic instrument names, no double-count).
  - **Pre-loaded Grafana dashboards** — an **Agora — Overview** (realtime connections, socket events,
    embedding throughput + latency percentiles, moderation decisions, feed-algorithm mix, recent logs)
    and an **Agora — Logs** (per-service volume + a live filterable stream) auto-provision into an
    *Agora* folder on boot, wired to the bundled datasources with trace↔log correlation.
  - The observability env vars (`OTEL_*`, `SERVICE_NAME`/`SERVICE_VERSION`, `SECURE_CHAT_SERVICE_NAME`,
    `GRAFANA_PORT`/`ALLOY_PORT`) are documented with defaults in `.env.example`. `docs/TELEMETRY.md`
    documents the whole layer (per-service signal table, the bundled dashboards, the
    `wonder-logger.yaml` shape, every env var, bundled + external-collector paths, troubleshooting);
    README updated to match.
- **GitHub wiki — a curated handbook authored in-repo.** A new `wiki/` directory holds the wiki source
  (Home + `_Sidebar`/`_Footer` + section pages: Getting Started, Deployment, Architecture, API &
  Contract, Security, Governance, Secure Chat, Social Graph, Ecosystem, Contributing) that summarizes
  the project and links into the deep `docs/*.md`. A dependency-free `wiki-sync` workflow
  (`.github/workflows/wiki-sync.yml`) publishes `wiki/` to the repo wiki on every push to `root`
  (first run bootstraps the empty wiki). Edit pages via PR in `wiki/`, never in the published wiki.
- **`NEO4J_DATABASE` — configurable DozerDB database for the social graph.** Names the DozerDB
  database all social-graph traffic targets (DozerDB re-enables Neo4j multi-database on Community);
  unset → `neo4j` (the server default), so existing deployments are unaffected. The API threads it
  into every read session/query (`lib/neo4j.ts` `neo4jDatabase()`; weather/neighborhood/GDS); the
  scorer (sole writer) binds all writes to it (`scorer/neo4j.py` `db_session`) and **auto-creates it
  on startup** (`CREATE DATABASE … IF NOT EXISTS` against the `system` db, name regex-validated as an
  injection guard). Compose ties the server's default database to the same var so the named DB
  restarts online. **api + scorer MUST share the value.**
- **Outbound embed throttle — abuse protection on Voyage calls (`lib/embed-throttle.ts`).** A per-project,
  in-process circuit breaker with hysteresis guards every Voyage embedding call so a runaway client/script
  can't blow through Voyage's limits or our bill. When a project's embed rate (req/sec, averaged over
  `EMBED_THROTTLE_WINDOW_SECONDS`) crosses `*_SPIKE_RATE` the breaker trips and stops embedding for that
  project until the rate falls to `*_RESUME_RATE` and stays there for `*_RESUME_MS`. **Write** and
  **search** are gated independently (`EMBED_THROTTLE_WRITE_*` / `EMBED_THROTTLE_SEARCH_*`). Each stream is
  **off until its `*_SPIKE_RATE` is set**; `RATE_MAX` (elevated/warn) and `RESUME_RATE` (normal level)
  default to fractions of `SPIKE_RATE`. Write-path embeds skipped while tripped are persisted to the new
  **`pending_embeddings`** table (migration `0052`, RLS deny-all) and replayed by
  **`POST /internal/cron/drain-embeddings`** (`?limit=`, default 100; also `scripts/drain-embeddings.mjs`)
  at a bounded pace; search-path embeds return **`429 search/throttled`** (no stored artifact to defer).
  `EMBED_THROTTLE_MAX_PENDING` optionally caps the backlog table. Disabled by default — no behavior change
  unless configured.
- **Self-service account deletion — `POST /auth/request-account-deletion` + `/confirm-account-deletion`.**
  The SDK's `useRequestAccountDeletion`/`confirmAccountDeletion` flow: step 1 emails a confirmation code
  (profile-keyed `account_deletion_codes`, so it works for **both** native and Supabase users); step 2
  verifies it and applies the project's **`account_deletion_mode`** (migration `0051`):
  - **`hard`** (default) — removes the identity (native credential deleted / Supabase
    `admin.deleteUser`); the **profile row is deleted**, so authored posts/comments survive as authorless
    (`user_id` set-null — content is community property) and engagement cascades away.
  - **`soft`** — disables the identity (native `disabled_at` / Supabase `admin.deleteUser(id, true)`); the
    **profile is retained but deactivated** (`is_active=false`).
  - **`ban`** — reversible disable (native `disabled_at` / Supabase `admin.updateUserById` long
    `ban_duration`); profile retained + deactivated.

  All modes revoke every session, and a disabled native credential can never sign in
  (`verifyCredentials` rejects `disabled_at`). The `auth/deletion-unsupported` throw is gone — Supabase
  is fully supported via the service-role admin API. (Migration `0049`'s `auth_email_tokens` `delete`
  kind is now unused, superseded by the profile-keyed code store.)
- **`/db` custom tables — full CRUD (`useTable`/`tablesApi`).** A generic per-project JSONB row store at
  `/db/:tableName` (+ `/:rowId`, `/:rowId/restore`): list with the 10 filter operators
  (`eq/ne/gt/gte/lt/lte/in/contains/like/isNull`) + `sortBy`/`sortDir` + `includeDeleted`, create, update,
  soft-delete (`?force=true` to hard-delete), and restore. New `table_rows` table (migration `0050`, with
  RLS deny-all). **Access model: per-row ownership** — a caller sees/edits only rows they created; project
  admins/operators bypass. Filter column names + values are bound as SQL parameters (never interpolated);
  numeric comparisons are regex-guarded so `::numeric` can't error on a text column. The whole feature was
  unimplemented server-side (every SDK call 404'd).
- **SDK contract conformance — `GET /entities/:id/reactions` + `GET /comments/:id/reactions`.** Paginated
  "who reacted" lists (`{ id, userId, reactionType, createdAt, user }` + standard envelope), gated by the
  same read access as the target content. The SDK (`useFetchEntityReactions`/`useFetchCommentReactions`)
  called these but the server only had POST/DELETE — every call 404'd.
- **SDK contract conformance — `GET /spaces/mutual/:userId`.** Spaces in which both the caller and
  `:userId` are active members (`useFetchMutualSpaces`); the endpoint did not exist (fell through to
  `/:id` → 404).
- **SDK contract conformance — `GET /users/:userId/connections`.** A specific user's established
  connections (`useFetchConnectionsByUserId`), mirroring `GET /connections` but scoped to `:userId`; the
  plural-list route was missing.
- **SDK contract conformance — `PATCH` + `DELETE /collections/:id`.** Rename/reparent
  (`useUpdateCollectionMutation`) and delete (`useDeleteCollectionMutation`) a collection; neither route
  existed (rename/delete 404'd). Delete relies on FK cascade for sub-collections + `collection_entities`.
- **SDK-driven conformance tests** (`test/integration/sdk-conformance.test.ts` +
  `src/lib/contract-schemas.test.ts`). The SDK is now the executable spec: tests assert the server accepts
  exactly what each hook sends and returns what it reads, so contract drift fails CI instead of slipping
  past the demo's happy paths.
- **`docs/REDIS.md` — the Redis reference.** A concise operator doc for Agora's two Redis consumers: the
  fail-closed **suspension index** (O(1) disabled-account enforcement; how it hydrates/reconciles and why
  secure-chat treats Redis as a hard dependency) and the cross-replica **rate-limit store**, plus
  least-privilege ACL recipes (per-service + combined) and the eviction-policy caveat (don't let
  `allkeys-lru` evict the no-TTL suspension SET). Linked from `apps/api/README.md`.
- **`.env.local.example` — ready-made local self-host config template.** A committed template wired for
  `docker compose --profile full --profile selfhost` (local Postgres + MinIO + scorer + neo4j +
  secure-chat + redis behind the Caddy front door on plain HTTP), with every self-hosted var pre-set and
  an `openssl` generation command beside each secret placeholder (`rand -hex 16` for passwords that live
  in URLs / `NEO4J_AUTH`, `rand -base64 48` for token secrets). Copy → fill placeholders → `cp .env.local
  .env`. Referenced from the `docs/SELF-HOSTING.md` quick start. (`.env.local` stays gitignored.)
- **`docker-compose.prod.yml` — pull-only production compose.** A second compose file that runs the
  stack from the published Docker Hub images (`agoraserver/agora-*`) instead of building from source —
  no repo checkout needed to build, only the compose file + `.env` + the proxy config. Same two-axis
  profile model as the dev `docker-compose.yml`, plus three production-hardening differences: images
  are pulled and pinnable via `AGORA_TAG` (defaults to `latest`), backend ports are **not** published
  to the host (only the proxy's `80`/`443` are public; everything else is reached over the internal
  network), and the header documents the small deploy bundle a pull-only host still needs (`.env`, the
  `deploy/proxy/` Caddy config, the `neo4j/plugins/` GDS jar for `scorer`/`full`).
- **CI: publish `agora-secure-chat` + `agora-cron` images.** The `docker-publish` workflow now builds
  and publishes all **six** buildable services (was four) — adding the blind MLS E2E delivery process
  (`apps/secure-chat/Dockerfile`) and the supercronic scheduler (`apps/api/Dockerfile.cron`) as
  multi-arch images on `ghcr.io/jenova-marie/*` + `docker.io/agoraserver/*`. This is what makes a
  fully pull-based `--profile full` production deploy possible (`docker-compose.prod.yml` above).
- **`docs/CHEAT-SHEET.md` — deployment recipes ↔ env vars ↔ where to get the values.** A one-page operator
  reference mapping each compose recipe (the two-axis profile model) to the env it requires, marking
  required vs optional and compose-injected vars, and naming the source for every value (Supabase
  dashboard paths, `openssl rand`, Voyage/Anthropic consoles, etc.) — plus minimal `.env` templates per
  recipe. Linked from `README.md` and `.env.example`.
- **Admin: app version shown in the header.** The Topbar renders the `@agora/admin` `package.json`
  version (e.g. `v0.12.1`) next to the project id. The value is injected at build time as the
  `__APP_VERSION__` global via Vite `define` (no runtime fetch). Bump `apps/admin/package.json`'s
  `version` to update it.
- **API load-test harness for performance baselines (`apps/api/perf/`).** A reproducible k6 workload
  + deterministic fixture seeder for tracking latency/throughput as the API evolves. `pnpm perf:seed`
  bulk-builds an isolated corpus (its own throwaway `project_id`: profiles + entities + multi-level
  comment threads) directly in Postgres and mints HS256 tokens; `pnpm perf:baseline` orchestrates
  seed → k6 → a git-stamped JSON summary under `perf/baselines/`. The scenario models a read-heavy
  social-feed mix (feed list / single entity / comment list / recursive thread / reaction + comment
  writes), tags requests per-endpoint, and ships per-endpoint p95 thresholds that double as a CI
  regression gate. `perf/compare.mjs` diffs two baselines into p95/p99 + throughput deltas. Canonical
  target is the local self-host docker stack (lowest variance). REST only; realtime deferred. See
  `apps/api/perf/README.md`. Requires k6 (`brew install k6`); no other new deps.

### Changed
- **Bake the default front-door config into the `agora-proxy` image.** The auto-ACME `Caddyfile` and the
  shared `agora-routes.caddy` routing snippet are now `COPY`-ed into the image (next to the SPA), so the
  common HTTPS deploy needs **no proxy config files on the host** — the default ACME/HTTPS path is just
  `docker-compose.prod.yml` + `.env`. Everything still resolves at runtime (`SERVER_NAME` drives the TLS
  mode: real domain → Let's Encrypt, `localhost` → internal CA, `:80` → plain HTTP/no ACME). The dev
  `docker-compose.yml` keeps bind-mounting the repo copies so routing/headers stay hot-editable without a
  rebuild (mount wins over the baked file); `docker-compose.prod.yml` drops those mounts. The `.onion` /
  static-cert variant stays an advanced opt-in: mount `Caddyfile.onion` (+ certs) over the baked defaults.
- **CI: publish `agora-proxy` instead of `agora-admin`.** The `docker-publish` workflow built the
  admin image from `apps/admin/Dockerfile`, which the front-door collapse deleted — so tagged releases
  failed with `failed to read dockerfile`. The matrix now builds the Caddy front door from
  `deploy/proxy/Dockerfile` (admin SPA baked into `/srv`) and publishes it as
  `ghcr.io/jenova-marie/agora-proxy` + `docker.io/agoraserver/agora-proxy`. Bumped `actions/checkout`
  to `v5` (Node 24). **The `agora-admin` image is retired** — pull `agora-proxy`.
- **Single Caddy front door — collapsed the two-layer proxy.** The admin nginx no longer exists as its
  own service. The **`proxy`** (Caddy) is now the single public entrypoint: it serves
  the admin SPA static build (baked into a new [`deploy/proxy/Dockerfile`](deploy/proxy/Dockerfile)) AND
  reverse-proxies every service itself — `/v7` + `/socket.io` → agora, `/v7/:projectId/secure-chat/*` +
  `/secure-socket/` → secure-chat, `/moderator` → scorer-worker, `/media` → minio. The routing + SPA
  config lives in a shared [`deploy/proxy/agora-routes.caddy`](deploy/proxy/agora-routes.caddy) snippet
  imported by both `Caddyfile` (auto-ACME) and `Caddyfile.onion` (static cert), so there's zero routing
  duplication. There is now **one proxy hop instead of two** → set **`RATE_LIMIT_TRUSTED_HOPS=1`** (was
  `2` behind the old caddy-edge + admin chain). For plain HTTP behind your own TLS terminator, set
  `SERVER_NAME=:80` (Caddy serves HTTP, skips ACME) — this replaces the old bare-admin-nginx-on-`:8080`
  mode. Docs updated (README, SELF-HOSTING, SECURITY, SCORER, SECURE_CHAT, deploy/proxy, CLAUDE.md, both
  app READMEs).
- **Compose: a two-axis profile model (replaces the single `full`-is-the-API-stack scheme).** A bare
  `docker compose up` starts nothing. **Axis 1 — data plane + API (required, pick exactly one):**
  `--profile supabase` (external Supabase Postgres + Storage) or `--profile selfhost` (local Postgres +
  MinIO); either brings up the API itself (`agora` + `proxy` + `cron`). **Axis 2 — optional add-ons
  (compose freely):** `--profile scorer` (the three `scorer-*` + `neo4j`), `--profile secure-chat` (the
  E2E delivery process + `redis`, **renamed from the old `secure` profile**), `--profile scale` (Redis
  rate-limit store), and `--profile full` = all add-ons at once. So "just the API" is now
  `docker compose --profile supabase up` (or `--profile selfhost`); "everything" is
  `--profile full --profile <supabase|selfhost>`. **`secure-chat` now rides `full`**, so a full deploy
  brings the E2E delivery process up behind the Caddy front door automatically (the standalone
  `docker compose --profile secure-chat up` still runs just `redis` + `secure-chat` against a remote
  `DATABASE_URL`). Migration/seed one-offs (`docker compose run --rm agora …`) are unchanged. Docs
  updated (README, SELF-HOSTING, SECURITY, SCORER, DOZERDB, deploy/proxy, CLAUDE.md, app READMEs).

### Removed
- **The `admin` nginx service, the `edge` profile, and `ADMIN_UPSTREAM`/`ADMIN_PORT`.** Folded into the
  single Caddy front door (see Changed): `apps/admin/Dockerfile` + `apps/admin/nginx.conf.template` are
  deleted (the admin SPA is built by `deploy/proxy/Dockerfile` now), the optional `edge` profile is gone
  (the front door rides the data-plane profiles), and the `ADMIN_UPSTREAM`/`ADMIN_PORT` env vars are no
  longer used.

### Fixed
- **SDK contract — request field names the server rejected with a 400.** `moderationSchema`,
  `changePasswordSchema`, `verifyEmailSchema`, and `createCollectionSchema` now accept the field names the
  sublay-fork SDK actually sends and normalize them to the existing handler shape: space moderation
  `{ action: "approve"|"remove" }` → `{ status: "approved"|"removed" }`, change-password `password` →
  `currentPassword`, verify-email `token` → `tokenHash`, create-collection `collectionName` → `name`. The
  native field names still work. (`parseBody` widened to accept `.transform()` schemas.)
- **SDK contract — HTTP method mismatches that 404'd.** `PATCH /entities/:id/publish` (`usePublishDraft`)
  and `PATCH /app-notifications/mark-all-as-read` (`useMarkAllNotificationsAsReadMutation`) are now
  accepted (both alongside the prior `POST`); mark-all-as-read returns `{ success, markedAsRead }`.
- **`@aws-sdk/client-s3` was declared but uninstalled**, breaking every integration test (eager import in
  the storage provider seam). Reinstalled via the lockfile.
- **`scorer-worker` (and the API's `/social/*`) couldn't reach Neo4j under Docker** — `.env`'s
  `NEO4J_URI=bolt://localhost:7687` is correct for host-side dev but inside a container `localhost`
  is the container itself, so the scorer logged `failed to ensure neo4j constraints (gave up)`
  (`Connect call failed ('127.0.0.1', 7687)`). The `agora` and `scorer-worker` compose services now
  override `NEO4J_URI` to the service-name address `bolt://neo4j:7687` (configurable via
  `NEO4J_URI_DOCKER`), matching how their other in-network URLs are wired. `.env` keeps `localhost`
  for host tooling. Other services that carry the var via `env_file` but never open a Bolt connection
  (classifiers, cron, secure-chat) are unaffected.
- **Migration 0027 (pgmq enqueue) failed on a self-hosted Postgres where pgmq wasn't pre-installed.**
  `CREATE EXTENSION pgmq` runs an install script that resets the session `search_path` to `''` (non-local
  `set_config`); because the migrator applies all migrations in one transaction, the next unqualified
  `create function` then failed with `no schema has been selected to create in`. Added the same
  `SET search_path TO public, extensions;` re-pin that 0000/0001/0007 already do after their
  `CREATE EXTENSION`. Never surfaced on Supabase (pgmq is pre-installed there, so `if not exists`
  short-circuits). Validated by applying the full migration chain against `supabase/postgres:15.8.1.060`.
  The edit is a no-op on already-migrated DBs (the migrator gates on the journal watermark, not file hash).

### Added
- **Secure-chat: IUC restore-blob relay** — a targeted, ephemeral, opaque courier so a peer device can
  hand a re-provisioned device its encrypted back-history off the MLS channel (the "ENVELOPE" history-
  restore variant). New `POST/GET/DELETE /v7/:projectId/secure-chat/restore-blobs` on `@agora/secure-chat`:
  the uploader must own `fromDeviceId` and be a conversation member, the target device's owner must be a
  member, and only the target's owner may fetch/delete (user-scoped authz with a non-distinguishing 404 —
  no existence oracle). The server stores opaque bytes only (new `secure_restore_blobs` table, RLS
  deny-all; no key/sha256/transferId columns). Lifecycle: explicit `DELETE` on confirm + a TTL backstop
  swept by `POST /internal/cron/purge-restore-blobs` (lazy-expiry hides expired blobs on read regardless)
  + standalone `scripts/purge-restore-blobs.mjs`. New env knobs: `MAX_SECURE_RESTORE_BLOB_BYTES` (16 MiB),
  `SECURE_RESTORE_BLOB_TTL_SECONDS` (900), `MAX_SECURE_RESTORE_BLOBS_PER_PAIR` (16),
  `MAX_SECURE_RESTORE_BLOBS_PER_TARGET` (64). Contract bumped to **0.13.0** (`uploadRestoreBlobSchema`,
  `RestoreBlobModel`, `UploadRestoreBlobResponse`). Migration `0048`. SDK integration guide:
  `apps/secure-chat/docs/RESTORE.md`; design: `docs/superpowers/specs/2026-06-20-iuc-restore-blob-design.md`.
- **Edge proxy: onion / static-cert mode via a second Caddyfile** (`deploy/proxy/Caddyfile.onion`).
  Let's Encrypt can't issue for a `.onion`, so the new variant serves a cert you supply at startup
  (`tls /certs/site.pem /certs/site.key`) and never attempts ACME. Selected without a new compose
  service: the `proxy` mount is now `${CADDYFILE:-./deploy/proxy/Caddyfile}` (default = today's auto-TLS
  behavior, unchanged) plus a read-only `${CADDY_CERTS_DIR:-./deploy/proxy/certs}:/certs` mount. New
  `.env` knobs: `CADDYFILE`, `CADDY_CERTS_DIR`, and `ACME_EMAIL` (opt-in LE expiry notices — also
  uncomment `email {$ACME_EMAIL}` in the auto Caddyfile). Cert/key files under `deploy/proxy/certs/` are
  gitignored (private keys never committed). Docs: `deploy/proxy/README.md` (onion workflow + Tor
  `HiddenServicePort 443 → caddy:443` mapping + WebCrypto secure-context rationale), `.env.example`.
- **Native admin bootstrap seed** (`apps/api/scripts/seeds/seed-native-admin.mjs`) — the no-Supabase
  counterpart of `seed-demo-user.mjs`. Inserts a **pre-confirmed** `auth_credentials` row (Argon2id, the
  same hash the app verifies) directly into the DB so a fully self-hosted (`auth_provider='native'`)
  deploy has a working email/password login on a virgin DB — no SMTP / email-confirmation round-trip
  needed (the default `ConsoleEmailSender` only logs the link). **Prompts** for the email + password
  (password hidden, entered twice) so no secret hits argv/`ps`/shell history; `ADMIN_EMAIL` +
  `ADMIN_PASSWORD` env override the prompt for CI. Idempotent; `--reset` rotates the password, `--test`
  targets `TEST_DATABASE_URL`. Pair the email with `OPERATOR_EMAILS` for god-view; the `profiles` row
  auto-creates on first sign-in. See `docs/SELF-HOSTING.md`.
- **Pluggable storage + fully self-hosted (no-Supabase) deploy.** The same `@agora/api` now runs either
  on Supabase (default, unchanged) or fully self-contained. Object storage is abstracted behind a
  `StorageProvider` seam (`apps/api/src/lib/storage/`): `STORAGE_PROVIDER=supabase` (default) keeps
  Supabase Storage; `STORAGE_PROVIDER=s3` uses any S3-compatible store (MinIO for self-hosting, or AWS
  S3) — bucket + public-read policy auto-created in-code on first upload. `lib/storage.ts`'s
  `uploadBytes`/`publicUrl` delegate to the seam, so all call sites (`lib/images.ts`, `routes/storage`,
  …) and the `files` table are unchanged. A new `selfhost` compose profile adds local Postgres
  (`supabase/postgres`) + MinIO; the admin nginx serves public media at `/media` → MinIO. New env:
  `STORAGE_PROVIDER`, `S3_*`, `DEFAULT_AUTH_PROVIDER` (stamps a genesis project's auth backend),
  `POSTGRES_PASSWORD`, `MINIO_ROOT_*`. OAuth (Supabase-brokered) cleanly returns `oauth/not-configured`
  when unconfigured. See `docs/SELF-HOSTING.md`.
- **Secure-chat extracted into its own deployable app** (`apps/secure-chat`, `@agora/secure-chat`) —
  the blind MLS (E2E) Delivery Service is now an **independent process** split out of `@agora/api`
  (own Hono server + own socket.io server + own entrypoint), so it can be load-balanced and deployed
  separately (v1 shares the main Postgres + Redis; onion / standalone-DB is a planned v2). Same REST
  surface (`/v7/:projectId/secure-chat/*`) and same `/secure` socket events, but the realtime now runs
  on its **own engine.io path `/secure-socket/`** (socket.io namespaces can't be path-split across
  processes) — the admin nginx routes `/v7/:projectId/secure-chat/*` + `/secure-socket/` to the new
  service. **SDK coordination:** the secure client (`../agora-sdk`) must target the secure-chat origin +
  `path:"/secure-socket/"` + namespace `/secure` (events unchanged).
- **`@agora/core` shared kernel** (`packages/core`) — a new internal package holding the env schema,
  logger (+ `wonder-logger.yaml`), Drizzle db client + full schema, http error/context, auth + project
  middleware, validation/`parseBody`, suspensions (read), and the Redis client. Both `@agora/api` and
  `@agora/secure-chat` consume it; `@agora/api` re-exports each moved module via thin shims so existing
  import sites are unchanged. Build order is now contract → core → (api, secure-chat).
- **Redis-backed, fail-closed suspension index** — suspension enforcement (`hasActiveSuspension`, on
  every authed request + socket handshake) now goes through a Redis SET (`suspended:profiles`) for an
  O(1) check when `REDIS_URL` is set; unset → the authoritative DB read (hermetic for tests + single
  replica). **Fail-closed:** a configured-but-unreachable Redis → `503` (never a silent allow, no DB
  fallback). Maintained by hydrate-on-boot (atomic rebuild) + write-through on suspend/lift + a
  reconcile cron `POST /internal/cron/sync-suspensions` (+ `scripts/sync-suspensions.mjs`, scheduled
  every 5 min). `@agora/secure-chat` treats Redis as a hard dependency with a `/health` readiness gate
  (refuses traffic until the index hydrates, so an empty set can't fail open).
- **Per-space read receipts** (corporate tier, PR 8) — compliance surface answering "did members
  see the policy announcement?". New `read_receipts` table (`(projectId, entityId, userId)` PK, RLS
  deny-all, migration `0047`) + `spaces.read_receipts_enabled` boolean opt-in. **`POST
  /entities/:id/read`** records an idempotent read (gates: auth → space read access → space
  `readReceiptsEnabled` + project `readReceiptsAllowed`). **`GET /admin/social/read-receipts`**
  returns operator-only live coverage: per-space list of announcement posts with `readerCount /
  memberCount` and a `readReceiptCoverage` ratio. **`PATCH
  /admin/social/read-receipts/spaces/:spaceId`** toggles per-space opt-in (operator + corporate
  gate). `shapeSpace` gains `readReceiptsEnabled` so clients can render the receipt badge. New admin
  **Spaces** section (`/spaces` nav + `SpacesPage`): master-detail list with a basic-settings editor
  (project-admin) and a read-receipts toggle + per-post coverage panel (operator). `requireSpaceRole`
  folds in project admins/operators so the admin Spaces page can edit spaces it doesn't own.
- **CO_PARTICIPATES social-graph edge** (SOCIAL-GRAPH §7 Phase 2). The scorer projects an undirected,
  structurally-neutral edge between users who comment in the same thread (canonical `(min,max)` key,
  windowed + capped + weight-clamped via `SCORER_CO_PARTICIPATES_LOOKBACK_DAYS` / `_MAX_PARTICIPANTS` /
  `_MAX_WEIGHT`). `GET /social/neighborhood?includeCoParticipates=true` opts a member's view into these
  ties (default off; adds neighbors at the floor brightness, contributes 0 warmth/friction). Neo4j-only —
  no Postgres migration.
- **Release script** (`scripts/release.sh`) — automated version bumping for monorepo releases. Bumps all `package.json` versions (root + contract + api + admin), commits with `chore(release): vX.Y.Z`, and creates a git tag. Fixes the gap where v0.12.0 tagged before package versions were bumped, so npm-publish published 0.11.0 instead. See `docs/RELEASE.md` for usage.
- **Manifest-driven seed engine** (`apps/api/scripts/seeds/seed-engine.mjs` + `seed.json`, run via
  `pnpm seed:graph`) — a declarative dev seeder that creates an interconnected fixture set (users,
  spaces, memberships, posts, comments, follows, connections, reactions) over the live API in fixed
  dependency order, so manifest handles resolve to real IDs by construction. Intended to run **once on
  a clean DB** (no idempotency/ledger). Kept out of the `pnpm seed` orchestrator (different paradigm,
  creates its own users).

### Changed
- **Secure-chat observability** — `routes/secure-chat.ts` + `realtime/secure-socket.ts` now emit
  structured `debug`/`trace` logs at every boundary (previously only device-register + conversation-
  create logged). Two tiers: `debug` covers lifecycle/state-transitions and **every expected
  rejection** — device register/revoke, key-package publish/claim/exhaustion, conversation create
  (with seeded `initialEpoch`), member add/remove, **epoch-conflicts** (logs attempted vs DS epoch),
  message send, device-mismatch, epoch-out-of-range, key-backup store; `trace` covers the
  high-frequency firehose — handshake polls (with per-row `seq/kind/epoch/targeted` breakdown), socket
  fan-outs (with no-op detection), key-package counts/low-water nudges, key-backup hit/miss, and the
  socket **device-room auto-join set** on connect (the smoking gun for the "waiting for key update"
  device-churn failure). Opaque bytes are never logged — only byte lengths; all bigint epochs/seqs are
  stringified. No API/contract change; default `LOG_LEVEL=debug` so the lifecycle tier is on in dev.

### Fixed
- **Metrics flush no longer fails (and double-counts) when a project is deleted mid-flight.** The
  `api_usage` meter buffers per-request deltas and flushes them ~10s later (`lib/metrics.ts`); if a
  project was deleted between a request and its flush (the e2e teardown race, but also any prod
  project-delete with requests in flight), the `api_usage → projects` FK rejected the insert. The old
  catch then merged the **entire** snapshot back — re-queuing already-inserted buckets (double-count)
  and a deleted-project bucket that could never land (poison pill spamming `[metrics] flush failed`
  every 10s forever). Now each bucket flushes independently: an FK violation (`23503`, project gone)
  **drops** that metric (`debug`-logged), a transient error re-queues only its own bucket, and one
  bad project can't corrupt another's counts. Covered by new `lib/metrics.test.ts`.
- **A malformed socket event could crash the entire API process.** An async socket.io listener that
  rejected (e.g. `join:secure-conversation` / `join:conversation` with an `undefined` `conversationId`,
  which fed `undefined` to a Drizzle query → postgres `UNDEFINED_VALUE`) became an **unhandled
  rejection**, which Node turns into a fatal uncaught exception — taking the whole server down. Now:
  (1) both realtime namespaces (`realtime/socket.ts`, `realtime/secure-socket.ts`) validate
  client-supplied ids at the boundary and fail closed, and wrap every handler (and the device-room
  auto-join) so a failure is logged and contained instead of escaping; (2) `index.ts` installs
  process-level `unhandledRejection`/`uncaughtException` guards as a last-resort net so no stray
  background rejection can crash the API. Realtime is best-effort — a bad event no longer brings the
  server down.
- **`PATCH /v7/:projectId/users/:id` returned 500 on a taken username** instead of a clean conflict.
  The `(project_id, username)` unique violation (Postgres `23505`, wrapped by Drizzle) is now mapped
  to **409 `users/username-taken`** (field `username`) rather than leaking an unhandled
  `DrizzleQueryError`.
- **`PATCH /v7/:projectId/settings/social` silently dropped `neighborhoodIncludeInteractions`** — the
  key was missing from the handler's update allow-list, so the admin Settings toggle reverted to
  disabled after every save. The field is now persisted (server) and the toggle sticks (admin UI).

## [0.12.0] - 2026-06-16

### Added
- **Per-project role system — `project_roles` (`owner | admin | steward`)** (managed-hosting
  sub-project B). Splits the single deployment-wide env `isOperator` god-flag into a **platform-operator**
  (cross-tenant, the hosting provider — unchanged env allowlist) and **per-project owner/admin** (god
  within one tenant, a DB grant), so the control plane can hand each tenant a project owner without
  granting deployment-wide power. New `project_roles` table (migration `0044`) + RLS deny-all & a
  backfill of existing `project_stewards` rows into `project_roles(role='steward')` (`0045`).
  `lib/project-roles.ts` resolves a profile's roles (30s cache, mirrors `social-config`) and exposes
  the hierarchy guards `isProjectOwner`/`isProjectAdmin` + throwing `requireProjectOwner`/`requireProjectAdmin`
  (`operator ⊇ owner ⊇ admin ⊇ steward`). Grants fold into the access JWT at mint/refresh as new
  `powner`/`padmin` claims (`lib/tokens.ts`), read back in `middleware/auth.ts` as
  `AuthContext.isProjectOwner`/`isProjectAdmin` (and surfaced on `AuthUser`) — effective on the
  grantee's next token refresh, like the operator/steward flags. New **`GET/POST/DELETE
  /v7/:projectId/roles`** grant-management endpoints (view = project-admin, mutate = project-owner;
  last-owner revoke blocked with `roles/last-owner`). The **`isOperator` audit**: every within-project
  power (space access, moderation visibility, search, report scope + resolve, suspensions, project/feed/
  webhook/social config, the dashboard scope + community-health overview, steward case access) now
  accepts project owner/admin; deployment powers (`/admin/config`, `/admin/umami/overview`, the
  Supabase DB-size + server-resource cards) stay operator-only. Admin app surfaces the new tier:
  `AuthContext` exposes `isProjectOwner`/`isProjectAdmin`, the sidebar gates Community on project-admin
  and the steward-grant card on project-owner, and the role badge shows Operator → Owner → Admin →
  Steward → Moderator. **Non-regression:** a single-project deployment with an env operator and zero
  `project_roles` rows behaves exactly as before (operator satisfies every `isProject*` predicate).
- **Admin analytics tier — the corporate counterpart to the Garden** (docs/AGORA-CORP.md §2,
  SOCIAL-GRAPH.md §7 Phase 4). Three **operator-only, NAMED**, corporate-tier reports read from one
  combined `social_analytics` snapshot table (migration `0046`): **`GET /v7/:projectId/admin/social/influence`**
  (informal leaders via GDS PageRank + bridge people via GDS betweenness, computed over one shared
  projection), **`/admin/social/silos`** (named GDS Louvain clusters mapped to their dominant spaces —
  the receipts counterpart to the k-anonymized Constellation, with **no k-anon** because the operator is
  the accountable employer), and **`/admin/social/engagement`** (per-person warmth-received `S_p` reusing
  the Weather math, plus a **churn-risk band** — `none`/`watch`/`at-risk` — from the relative decline over
  the trailing weekly `S_p` series). Plus **`POST /admin/social/recompute`**, an operator-forced
  **synchronous** recompute that bypasses the weekly epoch gate and returns the fresh report(s). Each
  surface applies the operator gate (`403 admin/operator-required`) then its per-report corporate-flag
  gate (`400 social/<report>-disabled`; community tier forces the flags off), and returns the empty
  `{ …, asOf: null }` sentinel (200, never 404) when nothing is materialized. Materialized weekly by
  **`POST /internal/cron/social-analytics`** (Sun 05:00, after the Constellation pass) with an in-lib
  per-report epoch gate that self-heals a missed run. Snapshots store **raw ids + scores only** — names
  and space labels are hydrated fresh at read, so they never go stale. New shared `lib/social-gds.ts`
  (`withProjectedGdsGraph` — feature-detect + Cypher projection + drop-in-`finally`, lifted out of the
  Constellation's `louvainCommunities`, which now reuses it) and `lib/social-analytics.ts` (pure
  `topByScore`/`dominantSpaces`/`churnFromSeries` + the compute/rollup/read functions). API-first; the
  operator React dashboards ship in the entry below.
- **Operator analytics dashboards (admin UI)** — the React surface for the admin analytics tier above
  (docs/AGORA-CORP.md §2, SOCIAL-GRAPH.md §7 Phase 4). A new operator-only **Social** page in `apps/admin`
  (`routes/SocialAnalyticsPage.tsx` + `lib/social-analytics.ts`) renders the three reports as tabs —
  **Influence** (informal-leaders + bridge-people ranked lists with score bars), **Silos** (cards with
  exact size, dominant-space badges, and member rosters), and **Engagement** (a table with `S_p`, an
  inline trend sparkline, the period delta, and a churn-risk badge). Each tab reads its latest snapshot
  and carries a **Recompute** button that POSTs `/admin/social/recompute` for that one report and seeds
  the React-Query cache from the synchronous response (a "this can take a while" pending state for the
  GDS run). State matrix mirrors the API gates: a community-tier `400 social/<report>-disabled` renders
  as a "corporate tier required" card linking to Settings → Social graph, a `503` as a quiet
  "Neo4j not configured" note, and an unmaterialized `asOf:null` snapshot as an empty state with the
  recompute action. The sidebar entry is operator-only **and** gated on `VITE_SOCIAL_GRAPH_ENABLED`
  (mirrors the Settings social panel), so a deployment without the social graph never shows a dead tab.
- **Auth-provider abstraction + native auth** (managed-hosting sub-project A): `projects.auth_provider`
  (`supabase` default | `native`) selects the credential backend per project via `lib/auth/`
  (`getAuthProvider`). `SupabaseAuthProvider` preserves the existing Supabase Auth behavior (no
  regression); the new `NativeAuthProvider` is an Agora-owned credential store for the shared hosting
  tier — argon2id password hashes (`@node-rs/argon2`), per-tenant identity (`unique(project_id,
  email)`, email lowercased), and hashed, single-use, expiring confirm/reset tokens. Confirm/reset
  emails go through a pluggable `EmailSender` (dev `ConsoleEmailSender`; link base `AUTH_EMAIL_LINK_BASE`).
  New tables `auth_credentials` + `auth_email_tokens` (migrations `0041`/`0042`) with RLS deny-all
  (`0043`). New endpoint **`POST /v7/:projectId/auth/reset-password`** (`{ token, newPassword }`)
  completes a password reset. Email fields capped at RFC-5321 254 chars. SDK contract unchanged
  (default `supabase`).
- **Constellation — the anonymous community shape** (docs/AGORA-SOCIAL.md §12, SOCIAL-GRAPH.md §3),
  completing the member-facing Garden (Weather → Constellation → Neighborhood). `GET
  /v7/:projectId/social/constellation` returns cluster **blobs** — a bucketed size (`5–9`, `10–19`, …) and
  a warmth band, with **no ids, names, or member lists**. Clustering is **GDS Louvain**
  (`gds.louvain.stream`) over the warmth/structure graph (`INTERACTED ∪ FOLLOWS ∪ CONNECTED`; `FRICTION`
  excluded — friction never renders as structure), scoped by the project's user set, with a **by-space
  fallback** when OpenGDS is absent (feature-detected). Clusters smaller than `constellationKFloor`
  (default 5, admin-raisable) are **suppressed** (k-anonymity); each blob is tinted by its members' mean
  `S_p` (reusing the Weather warmth math). Per §12 it is **materialized seasonally** — a new
  `social_constellation` table (migration 0040) refreshed by `POST /internal/cron/social-constellation`
  on a weekly supercronic schedule with a ~6-week per-project epoch gate (never per-load); blobs carry no
  persistent identity (re-clustered fresh). The read serves the latest snapshot, returning an `asOf:null`
  "forming" payload (200, not 503) for a project never materialized. Gated by `graphEnabled &&
  constellationEnabled` (400 `social/constellation-disabled`). `social-weather` refactored to share
  `fetchWarmthPairs` + `personScoresFromPairs`.
- **DozerDB + OpenGDS setup** (`docs/DOZERDB.md`): documented the Neo4j graph database configuration
  for the social-graph layer. DozerDB is the fully open-source Neo4j 5 distribution that ships APOC
  and OpenGDS without an Enterprise license. Documents the two-mechanism plugin loading (APOC via
  `NEO4J_PLUGINS` auto-download; OpenGDS via the `./neo4j/plugins/` jar mount at `/plugins`),
  environment variables, memory-tuning guide, TLS production path, and verify commands. The `neo4j`
  service in `docker-compose.yml` enumerates each valid `NEO4J_*` config var explicitly (it can **not**
  use `env_file: .env` — Neo4j maps every `NEO4J_*` var to a config key, so the API/scorer's
  `NEO4J_URI` would crash it with `Unrecognized setting: URI`); scoped procedure security to
  `gds.*,apoc.*` (was `*`). The OpenGDS 2.12.0 jar is **gitignored** (`neo4j/plugins/*.jar`), downloaded
  once per `docs/DOZERDB.md`.
- **Single `NEO4J_AUTH` credential var** replacing `NEO4J_USER` + `NEO4J_PASSWORD` across the API
  (`lib/env.ts`, `lib/neo4j.ts`), the scorer (`config.py` `neo4j_credentials()`, `neo4j.py`),
  `docker-compose.yml`, and `.env.example` — the `user/password` string is now the one shared var
  between the Neo4j container (its native `NEO4J_AUTH`) and both clients, passed straight through.
- **Neighborhood — the personal Garden lens** (docs/AGORA-SOCIAL.md, SOCIAL-GRAPH.md §3):
  `GET /v7/:projectId/social/neighborhood` returns the **caller's own ties**, each with its **dyadic**
  brightness `B(me, them)` and the identity to render it. **By default a tie is a deliberate one — a
  follow or a connection**; interaction-only ties are **opt-in** via the project default
  `social_config.neighborhoodIncludeInteractions` (default off, admin-editable in Settings → Social
  Graph) or a per-member `?includeInteractions=true|false` override (the response echoes the effective
  `includesInteractions`). The toggle governs only *who appears* — a structural tie still glows from
  interactions either way. `FRICTION` only dims an existing tie (FLOOR-bounded) and never creates one (a
  report-only pair never appears). Warmth/friction reuse PR3's read-time decay, additive friction fold,
  and age cutoff — applied per dyad. **Self-view only** (keyed on the authenticated user), never another
  member's ties, and never the friend's global score (the asymmetry rule). No k-anonymity (named
  self-view). Gated by `graphEnabled && neighborhoodEnabled` (400 `social/neighborhood-disabled`) and
  Neo4j config (503 `social/graph-unavailable`); computed live (no cache — bounded by the caller's
  degree). No migration (`neighborhoodEnabled`/`neighborhoodIncludeInteractions` live in social_config).
- **Layer-2 `FRICTION` edges from reports, folded into Community Weather** (docs/SOCIAL-GRAPH.md §3,
  AGORA-SOCIAL.md §11). A user **report** now projects a directed
  `(reporter)-[:FRICTION {kind:'report', weight}]->(subject)` edge (subject = the reported content's
  author) via a new pgmq job kind (`friction`), enqueued by an `AFTER INSERT on reports` trigger
  (migration `0039_scorer_friction_enqueue.sql`) and MERGE-keyed on the report id (idempotent). Append +
  decay only — a resolved/dismissed report is a no-op in the graph (friction fades at the friction
  half-life; it isn't adjudicated there). Community Weather's friction term `F` is now **additive**:
  negative-`INTERACTED` sentiment **plus** the decayed `FRICTION` edges, `UNION ALL`'d in
  `WEATHER_PAIRS_CYPHER` and summed per directed pair (`mergePairRows`) before the unchanged brightness
  formula. Weather also gained a read-time **edge age cutoff** (~6 warmth half-lives): a fully dormant
  community now reads "quiet" instead of asymptoting to floor-dark "stormy", and the scan shrinks. The
  scorer creates a `FRICTION.projectId` index for the read side. Scope: `block`/`mute` friction is
  deferred (no such feature/table); downvotes stay `INTERACTED`-only.
- Community Weather (docs/SOCIAL-GRAPH.md §3): `GET /v7/:projectId/social/weather` returns the
  project's aggregate warmth `{value, band, trend, asOf}` computed live from Layer-1 `INTERACTED`
  edges with read-time decay (warmth + friction half-lives from social_config; zero-sentiment
  "neutral" edges excluded), cached per project for 1h with band hysteresis. Gated by
  `graphEnabled && weatherEnabled` (400 when off) and by the new optional
  `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` env vars (503 when unconfigured). The member
  transparency endpoint moved to `routes/social.ts` (path unchanged). The scorer now also creates
  a relationship index on `INTERACTED.projectId` for the read side. Admin: Community Weather card
  on the Community dashboard.
- Social-graph configuration foundation (`projects.social_config`): the community↔corporate
  privacy tier from `docs/SOCIAL-GRAPH.md` §5. Zod-validated contract schema + per-tier defaults
  with two-point enforcement (forbidden flags rejected on write with `social/tier-forbidden`,
  clamped at read time), admin `GET/PATCH /settings/social`, member-facing
  `GET /social/transparency` (the active tier + enabled analytics are always visible to members),
  and an admin Settings → Social Graph panel. Migration `0038`.
- **`services/scorer` relationship graph v2 — the user→user interaction graph.** The Neo4j graph now
  records distinct edge types (combined only at read time, never blended): a scored, append-log
  **`INTERACTED`** edge (`actor → recipient`, `MERGE`-keyed on the source id so pgmq redelivery / edits
  re-`SET` one edge) plus two structural edges — **`FOLLOWS`** (asymmetric, mirrors the `follows` table)
  and **`CONNECTED`** (mutual, mirrors the `connections` table). The actor is the comment/reply/reaction
  author; the recipient is the **parent-content author** (comment→entity author, reply→parent-comment
  author, reaction→content author). Text interactions carry the relationship-RoBERTa sentiment; reactions
  derive it from the reaction *type* (`scorer/reaction_sentiment.py`). Reaction removal / unfollow /
  disconnect **delete** the edge (retractable); self-interactions and chat-message-target reactions are
  skipped (chat is E2E-encrypted, out of scope). New migration `0036_scorer_graph_v2_enqueue.sql` adds
  `reactions` (insert/delete/retype-gated) + `follows` (insert/delete) triggers;
  `0037_scorer_connection_enqueue.sql` adds `connections` triggers **gated on the `pending → connected →
  declined` lifecycle** so the `CONNECTED` edge exists only while `status='connected'` (created on
  accept/direct-connect, deleted on disconnect — which is a row DELETE, not a status flip; `declined` =
  no edge). All enqueue onto the **same** `scorer_jobs` queue with a `kind` discriminator
  (`reaction`/`follow`/`connection`); the worker's `dispatch_job` routes content (scored) vs. graph-only
  jobs. Being connected does **not** imply following (and vice-versa) — only `follows` drives the feed.
  Unit-tested **and smoke-validated end-to-end** against live Postgres + Neo4j (correctly-directed edges
  for comment/reply/reaction/follow/connection, type-mapped reaction sentiment incl. negative cases, the
  `CONNECTED` status-gate, edge deletion on reaction-removal/unfollow/disconnect, and the
  self-interaction + chat-message-target skips). Design spec (incl. §8a):
  `docs/superpowers/specs/2026-06-08-relationship-graph-v2-design.md`.

### Changed
- **`isSteward` is now sourced from `project_roles`** (sub-project B). `lib/stewards.ts`
  (`isSteward`/`grantSteward`/`revokeSteward`/`listStewardIds`) now reads/writes
  `project_roles(role='steward')` instead of the `project_stewards` table; existing grants were
  backfilled (migration `0045`), and `project_stewards` is retained (deprecated) for now. Signatures
  are unchanged. The steward access gate widened: project owners/admins reach the Steward caseload too
  (steward grant/revoke moved from operator-only to project-owner). A couple of within-project admin
  error codes changed accordingly (e.g. suspend now returns `roles/admin-only`, steward grant/revoke
  `roles/owner-only`) — these are admin-only surfaces, not part of the SDK contract.

## [0.11.0] - 2026-06-08

### Added
- **`services/scorer` CI + multi-arch images (ops polish).** A `scorer` job in
  `.github/workflows/ci.yml` lints (ruff), type-checks (mypy), and unit-tests (pytest) the Python
  subsystem on every push/PR — hermetic (pure/mocked, no torch/DB/network), installing only the dev
  deps. The scorer images (`agora-scorer-worker` + `agora-scorer-model-server`) are added to
  `docker-publish.yml`, which is rewritten to **native-runner multi-arch** (amd64 on `ubuntu-latest`,
  arm64 on `ubuntu-24.04-arm`, no QEMU): each arch builds + pushes by digest, then a merge job stitches
  per-arch digests into one manifest per tag on both GHCR + Docker Hub — so the torch-heavy model server
  builds fast on both architectures.

### Fixed
- **Seed post scripts honor `API_BASE_URL` without a `/v7` suffix.** The 13 `scripts/seeds/seed-*-post.mjs`
  scripts treated `API_BASE_URL` as if it included the `/v7` version prefix (their default was
  `http://localhost:4000/v7`), so a root-form `API_BASE_URL=http://localhost:4000` (the form the
  `services/scorer` write-back + cron `/internal/*` endpoints require) produced `/<projectId>/…` URLs
  that matched no route → `common/not-found` (404) on sign-in, failing every post seed. The scripts now
  treat `API_BASE_URL` as the host root and append `/v7` themselves, tolerating either form — so
  `genesis && seed` works with the canonical root-form `API_BASE_URL`.
- **`services/scorer` test suite is hermetic + mypy-clean (CI prerequisite).** `tests/conftest.py` now
  **force-empties** `ANTHROPIC_API_KEY` (was `setdefault`, which a real key leaked via direnv/.env
  defeated → a real Haiku call → flaky gray-zone tests). Added the previously-undeclared `respx` test
  dep to `requirements-dev.txt` + `pyproject` `dev` extras. Fixed 8 mypy errors (`_settings(**over:
  object)` → `Any` in `test_haiku.py`/`test_writeback.py`) so the suite is mypy-clean across all source
  dirs.

### Changed
- **`services/scorer` no longer scores chat messages.** Agora has moved to an end-to-end-encrypted
  secure-chat platform, so the server never sees message plaintext — RoBERTa/Haiku scoring of
  `chat_messages` is impossible and meaningless. The two `chat_messages` enqueue triggers were removed
  from migration `0027_scorer_pgmq_enqueue.sql` (edited in place + re-`genesis`'d, pre-release), and the
  worker's `message`/`chat_messages` code paths were dropped (`scorer/db.py` content + author fetch,
  `ReportTargetType` narrowed to `entity`/`comment` in `models.py` + `auto_action.py`). The
  `chat_messages` table and the `reaction_target` enum's `message` value are **kept** — the latter still
  powers chat-message *reports*, a separate feature.
- **`Dockerfile.model-server`: arch-aware CPU-torch install + slim + HF cache.** Torch now installs the
  correct CPU wheel per arch (`TARGETARCH`: amd64 → pytorch `/whl/cpu` index; arm64 → PyPI default, since
  the cpu index has no aarch64 wheels), trims bytecode caches + torch's bundled tests, and sets `HF_HOME`
  to a pre-created (scorer-owned) dir. `docker-compose.yml` adds a shared `scorer-hf-cache` volume on
  both model servers so downloaded models survive a container recreate.

### Removed
- **Dead moderation-notifier path removed.** The `services/scorer` cutover left the old internal
  moderation webhook notifier dormant; it's now fully removed. Gone: `lib/webhooks.ts`
  `MODERATION_EVENTS` + the `broadcast()` moderation fan-out + `sendModerationTest`; the
  `projects.moderation_webhook_url` / `moderation_webhook_secret` columns (migration `0035` drops them);
  the `POST /settings/moderator/test` endpoint; the `url` / `secret` fields on `moderatorConfigSchema`;
  and the admin **Settings → Moderator** webhook card. Automated moderation runs entirely off the
  scorer's pgmq enqueue — admin **Settings → Moderator** now tunes only `projects.moderator_config`
  (auto-action thresholds + LLM config + categories). The external project webhook + sign-up validation
  webhook are untouched.

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

[Unreleased]: https://github.com/jenova-marie/agora/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/jenova-marie/agora/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/jenova-marie/agora/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/jenova-marie/agora/compare/v0.16.5...v0.17.0
[0.16.5]: https://github.com/jenova-marie/agora/compare/v0.16.4...v0.16.5
[0.16.4]: https://github.com/jenova-marie/agora/compare/v0.16.3...v0.16.4
[0.16.3]: https://github.com/jenova-marie/agora/compare/v0.16.2...v0.16.3
[0.16.2]: https://github.com/jenova-marie/agora/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/jenova-marie/agora/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/jenova-marie/agora/compare/v0.15.2...v0.16.0
[0.15.2]: https://github.com/jenova-marie/agora/compare/v0.15.0...v0.15.2
[0.15.0]: https://github.com/jenova-marie/agora/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/jenova-marie/agora/compare/v0.12.0...v0.14.0
[0.12.0]: https://github.com/jenova-marie/agora/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/jenova-marie/agora/compare/v0.10.0...v0.11.0
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
