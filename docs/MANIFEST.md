# Agora — Build Manifest

> The concrete contract Agora's server must implement to be consumed **1:1** by the client SDK,
> [`jenova-marie/agora-sdk`](https://github.com/jenova-marie/agora-sdk) — a fork of `@replyke/core`
> (Apache-2.0, `github.com/replyke/monorepo`) already repointed at an Agora server. Source extracted
> from the upstream SDK, commit fetched 2026-05-22.
>
> Legend: **✅ SDK-confirmed** = method+path read straight from SDK call sites.
> **🔶 inferred** = path seen in SDK but method/shape assumed from REST convention or
> the RTK-Query layer; verify against the published OpenAPI spec at `/openapi/v7`.

---

## 0. The client SDK (already forked + repointed)

**You do not need to fork or patch anything** — that work is done in
[`jenova-marie/agora-sdk`](https://github.com/jenova-marie/agora-sdk) (published under the `@agora-sdk/*`
scope). As a consumer you only point the SDK at your server via the base-URL env var:

```
VITE_API_BASE_URL   = https://YOUR_HOST/v7     # Vite
REACT_APP_API_BASE_URL = https://YOUR_HOST/v7  # CRA / React Native
# defaults to http://localhost:4000/v7
```

The socket origin is derived from that base URL, so realtime follows the same setting.

**For reference only** — what the fork repointed. The published Replyke SDK hardcoded
`https://api.replyke.com/v7` in spots the env var alone didn't cover; `agora-sdk` already patched
each one, so this table documents *what changed*, not work you need to do:

| File | Constant | Repointed (done in agora-sdk) |
|---|---|---|
| `config/axios.ts` | `export const BASE_URL = "https://api.replyke.com/v7"` | base URL env / your host + `/v7` |
| `utils/env.ts` | `getApiBaseUrl()` fallback `'https://api.replyke.com/v7'` (×3) | base URL env / your host |
| `hooks/search/useAskContent.ts` | hardcoded semantic-search URL | base URL env / your host |
| `context/chat-context.tsx` | `getSocketUrl()` origin (derived from BASE_URL) | your socket host |
| OAuth sign-in hook (`react-js`) | hardcoded origin | base URL env / your host |

(The RTK-Query layer, `store/api/baseApi.ts`, already respected
`VITE_API_BASE_URL` / `REACT_APP_API_BASE_URL` upstream.)

---

## 1. Global contract (must match exactly)

**URL shape:** `https://YOUR_HOST/v7/:projectId/<endpoint>` — `projectId` is the first
path segment after `/v7`.

**Auth header:** `Authorization: Bearer <accessToken>`.
- access token TTL **30 min**, refresh token TTL **30 days**
- refresh-token **rotation with reuse detection**: each refresh revokes the old token &
  issues a new one; replaying a spent token revokes the whole token family; **30s grace**
  window for racing tabs
- external auth: verify an **RS256** JWT against a per-project public key — claims
  `sub`, `iss` (project id), `aud: "replyke.com"`, `userData` — then mint your own pair

**Pagination envelope** (offset-based, `?page=&limit=`):
```json
{ "data": [ ... ],
  "pagination": { "page": 1, "pageSize": 20, "totalPages": 5, "totalItems": 93, "hasMore": true } }
```
> ⚠️ Note: the **connections** module uses a *different* pagination shape
> (`{ currentPage, totalPages, totalCount, hasNextPage, hasPreviousPage, limit }`) — see §3.

**Error envelope:**
```json
{ "error": "Human readable message", "code": "feature/slug", "field": "optional" }
```
Status codes: `400 / 401 / 403 / 404 / 409 / 429 / 500`.

**Deprecation header (RFC 8594):** a response to a request that used a **deprecated sort alias**
carries `Deprecation: true` (no `Sunset` — the aliases keep working indefinitely; there is no
scheduled removal). Emitted on `GET /entities?sortBy=new` and `GET /comments?sortBy=new|old`. The
canonical replacement is `sortBy=createdAt` (+ `sortDir`). The typed alias/dir surface is exported
from `@agora-server/contract` (`commentSortBySchema`, `sortDirSchema`); the server **coerces** an
unknown `sortBy` to `createdAt` rather than 400-ing (forward-compat).

---

## 2. REST endpoint checklist (grouped by module)

`:projectId` prefix omitted below for brevity — every path is `/v7/:projectId/<path>`.

### auth
| Method | Path | Status |
|---|---|---|
| POST | `/auth/sign-up` (→ `201` session, or `200 { status: "confirmation_required", email }` when email confirmation is enabled) | ✅ |
| POST | `/auth/sign-in` | ✅ |
| POST | `/auth/sign-out` | ✅ |
| POST | `/auth/request-new-access-token` | ✅ |
| POST | `/auth/change-password` | ✅ |
| POST | `/auth/request-password-reset` | ✅ |
| POST | `/auth/reset-password` (body `{ token, newPassword }`; completes a reset — required by the native auth provider) | 🔶 |
| POST | `/auth/verify-email` | ✅ |
| POST | `/auth/send-verification-email` | ✅ |
| POST | `/auth/request-account-deletion` (auth; emails a profile-keyed deletion code — native + Supabase) | ✅ |
| POST | `/auth/confirm-account-deletion` (auth; body `{ code }`; applies `projects.account_deletion_mode` ∈ hard/soft/ban — hard deletes the profile + identity and keeps content authorless, soft/ban deactivate + disable) | ✅ |
| POST | `/auth/verify-external-user` (body `{ userJwt }`; legacy `{ token }` also accepted) | ✅ |

**Native-auth email links (`sign-up` / `request-password-reset` / `send-verification-email`).** These
accept an optional `emailRedirectTo` (the client's app origin, e.g. `https://demo.agora-oss.org`) that
sets the base of the emailed confirm/reset link — so a multi-front-end deploy returns each user to the
site they signed up on. The server validates it against `AUTH_EMAIL_LINK_ALLOWED_ORIGINS` and rejects a
non-allowlisted origin with `400 auth/email-redirect-not-allowed`; when the allowlist is unset the field
is ignored and links use `AUTH_EMAIL_LINK_BASE`. Supabase-backed auth ignores it (it emails its own).

### oauth
Sign-in/link use Supabase as the OAuth broker (code + PKCE). `authorize`/`link` return
`{ authorizationUrl }`; the provider redirects the browser to `callback`, which exchanges the code,
mints Agora tokens, and 302-redirects to `redirectAfterAuth#accessToken=…&refreshToken=…` (or
`?error=…&error_description=…`). PKCE verifier is held in `oauth_states` between authorize→callback.
| Method | Path | Status |
|---|---|---|
| POST | `/oauth/authorize` (body `{ provider, redirectAfterAuth }` → `{ authorizationUrl }`) | ✅ |
| POST | `/oauth/link` (authed; same shape) | ✅ |
| GET | `/oauth/callback` (`?aid=&code=` or `?aid=&error=` → 302 redirect with tokens/error) | ✅ |
| GET | `/oauth/identities` | ✅ |
| DELETE | `/oauth/identities/:id` | ✅ |

### crypto (testing only)
Dev/quick-start only — the client sends its OWN external-auth private key (PKCS8) and the server
signs an RS256 JWT (issuer=projectId, aud="replyke.com", sub=userData.id, claim `userData`) that
`/auth/verify-external-user` then accepts. Returns a bare JWT string.
| Method | Path | Status |
|---|---|---|
| POST | `/crypto/sign-testing-jwt/v2` (body `{ privateKey, userData:{id,…} }` → JWT string) | ✅ |

### projects
| Method | Path | Status |
|---|---|---|
| GET | `/projects/lean` | ✅ |

### entities
| Method | Path | Status |
|---|---|---|
| GET | `/entities` (feed/list — accepts filters §5; `sortBy` also takes `createdAt` (first-class chronological, honors `sortDir`), `decay`/`gravity`/`wilson`/`bayesian`, plus optional `rankParams` JSON scalar, `rankAnchor` (echoed back), `rerank`. `new` is a **deprecated alias** for `createdAt` desc → emits `Deprecation: true` (§1)) | ✅ |
| POST | `/entities` (JSON, or `multipart/form-data` with `images.files`/`files.files` + `images.options` → uploaded files returned in `entity.files`) | ✅ |
| GET | `/entities/:id` | ✅ |
| PATCH | `/entities/:id` | ✅ |
| DELETE | `/entities/:id` | ✅ |
| GET | `/entities/by-foreign-id` (optional `createIfNotFound=true` lazily materializes an **authorless** anchor for external content on first view — SDK `EntityProvider`/`CommentSection`) | ✅ |
| GET | `/entities/by-short-id` | ✅ |
| GET | `/entities/drafts` | ✅ |
| POST/PATCH | `/entities/:id/publish` (SDK `usePublishDraft` uses PATCH) | ✅ |
| GET | `/entities/is-entity-saved` | ✅ |
| GET/POST/DELETE | `/entities/:id/reactions` (GET = paginated reactor list, `useFetchEntityReactions`) | ✅ |
| POST | `/entities/:id/read` (record a member read for receipt tracking; gate: auth → space read access → `space.readReceiptsEnabled + cfg.readReceiptsAllowed`; idempotent upsert; → `{ recorded: true, readAt }`) | ✅ |

### comments
| Method | Path | Status |
|---|---|---|
| GET | `/comments` (list; `entityId`, `parentId`, pagination; `sortBy` ∈ `createdAt`\|`top`\|`controversial`\|`new`\|`old` + `sortDir` (`asc`\|`desc`, honored for `createdAt`). `new`/`old` are **deprecated aliases** for `createdAt` desc/asc → emit `Deprecation: true` (§1); unknown `sortBy` coerces to `createdAt` desc) | ✅ |
| GET | `/comments/thread` (full nested subtree; `entityId`, `rootId?` → `{ data: Comment[] }` w/ `replies[]`) | ✅ |
| POST | `/comments` | ✅ |
| GET | `/comments/:id` (→ `{ comment }`; `include`=user,parent) | ✅ |
| PATCH | `/comments/:id` | ✅ |
| DELETE | `/comments/:id` | ✅ |
| GET | `/comments/by-foreign-id` (→ `{ comment }`) | ✅ |
| GET/POST/DELETE | `/comments/:id/reactions` (GET = paginated reactor list, `useFetchCommentReactions`) | ✅ |

### users
On the `/users/:id*` handlers (profile read/update, follow, follower/following lists + counts,
suspensions — marked "params validated" below; NOT `/by-username`, `/by-foreign-id`,
`/check-username`, or `/suggestions`), two optional query params are now VALIDATED —
`spaceReputationId: uuid|"none"|"context"` and `spaceReputationDescendants: "true"` — via
`validateSpaceReputationParams` (`"context"` → `400 space-reputation/context-not-allowed` on these
user-direct endpoints; `spaceReputationDescendants` without an explicit uuid id →
`400 space-reputation/descendants-needs-uuid`). **Validation only — enrichment is deferred**: no
response currently carries a space-scoped reputation value; a real tally/rollup + per-response
enrichment is a separate future spec.
| Method | Path | Status |
|---|---|---|
| GET | `/users/:id` (`spaceReputationId?`/`spaceReputationDescendants?` — validated, not yet enriched) | ✅ |
| PATCH | `/users/:id` (update profile; same params validated) | ✅ |
| GET | `/users/by-foreign-id` | ✅ |
| GET | `/users/by-username` | ✅ |
| GET | `/users/check-username` | ✅ |
| GET | `/users/suggestions` | ✅ |
| GET | `/users/:id/follow` (follow status; params validated) | ✅ |
| POST | `/users/:id/follow` (params validated) | ✅ |
| DELETE | `/users/:id/follow` (params validated) | ✅ |
| GET | `/users/:id/followers` (params validated) | ✅ |
| GET | `/users/:id/following` (params validated) | ✅ |
| GET | `/users/:id/followers-count` (params validated) | ✅ |
| GET | `/users/:id/following-count` (params validated) | ✅ |
| GET | `/users/:id/connections-count` (params validated) | ✅ (also exposed at the `/v7` root `/users/:userId/connections-count` via the connections module) |
| GET | `/users/:id/suspensions` (project-admin; params validated) | ✅ |

### follows
| Method | Path | Status |
|---|---|---|
| DELETE | `/follows/:id` | ✅ |
| GET | `/follows/followers` (`?query=&searchFields=username\|name`, comma-separated) | ✅ |
| GET | `/follows/following` (`?query=&searchFields=username\|name`, comma-separated) | ✅ |
| GET | `/follows/followers-count` | ✅ |
| GET | `/follows/following-count` | ✅ |

`query`/`searchFields` (default both `username`+`name`) apply an ILIKE filter to the resolved page of
followed/follower profiles. **Filtering runs AFTER id-pagination**, not before — `limit`/`page` bound
the underlying follow-edge query, and the text filter is applied to that page's profiles. So
`pagination.totalCount` reflects the **unfiltered** edge count, and a filtered page can return fewer
than `limit` rows even when more matches exist on later pages.

### connections (state machine: none → pending → connected/declined)
> Fully implemented in `routes/connections.ts` (mounted at the `/v7` root, not under `/:projectId` — the
> project is derived from the caller's profile). Response shapes are in `interfaces/models/Connection.ts`;
> connections pagination uses its own envelope (`{ currentPage, totalPages, totalCount, hasNextPage,
> hasPreviousPage, limit }` — see §1/§3). Operations the SDK exposes: send request, accept, decline,
> withdraw, disconnect, list connections (own + `GET /users/:userId/connections`), list pending
> (received/sent), connection status, connection count. Request/accept fan out over `notification:created`
> (types `connection-request` / `connection-accepted`); non-UUID path params are rejected with `400`.
> `GET /connections` and `GET /users/:userId/connections` both accept `?query=&searchFields=username|name`
> (comma-separated) — same ILIKE-on-the-resolved-page behavior as follows' `query`/`searchFields`
> (§follows): the filter runs AFTER pagination, so `totalCount` reflects the unfiltered connection
> count and a filtered page can come back shorter than `limit`.

### spaces
`POST`/`PATCH /spaces` accept an optional `visibility: public|unlisted|private` (default `public`;
migration `0058`), persisted and emitted on every space response. **Persist + emit only this cycle —
no listing/discovery filtering is applied** (an `unlisted`/`private` space is not hidden from
`GET /spaces`, search, or any other list); that's a future addition.
| Method | Path | Status |
|---|---|---|
| GET | `/spaces` (list, `?…`) | ✅ |
| POST | `/spaces` (`visibility?` — see above) | ✅ |
| GET | `/spaces/:id` | ✅ |
| PATCH | `/spaces/:id` (`visibility?` — see above) | ✅ |
| DELETE | `/spaces/:id` | ✅ |
| GET | `/spaces/by-short-id?shortId=` | ✅ |
| GET | `/spaces/by-slug?slug=` | ✅ |
| GET | `/spaces/check-slug?slug=` | ✅ |
| GET | `/spaces/user-spaces` | ✅ |
| GET | `/spaces/mutual/:userId` (spaces where both caller + `:userId` are active members; `useFetchMutualSpaces`. Static `mutual` segment declared above `/:id`) | ✅ |
| GET | `/spaces/:id/breadcrumb` | ✅ |
| GET | `/spaces/:id/children?page=&limit=` | ✅ |
| POST | `/spaces/:id/join` | ✅ |
| DELETE | `/spaces/:id/leave` | ✅ |
| GET | `/spaces/:id/members?…` | ✅ |
| DELETE | `/spaces/:id/members/:id` | ✅ |
| PATCH | `/spaces/:id/members/:id/role` | ✅ |
| PATCH | `/spaces/:id/members/:id/approve` | ✅ |
| PATCH | `/spaces/:id/members/:id/decline` | ✅ |
| PATCH | `/spaces/:id/members/:id/unban` | ✅ |
| GET | `/spaces/:id/membership/me` | ✅ |
| GET | `/spaces/:id/team` | ✅ |
| GET/PATCH | `/spaces/:id/digest-config` | ✅ |
| GET | `/spaces/:id/rules` | ✅ |
| POST | `/spaces/:id/rules` | ✅ |
| GET | `/spaces/:id/rules/:id` | ✅ |
| PATCH | `/spaces/:id/rules/:id` | ✅ |
| DELETE | `/spaces/:id/rules/:id` | ✅ |
| PATCH | `/spaces/:id/rules/reorder` | ✅ |
| PATCH | `/spaces/:id/entities/:id/moderation` | ✅ |
| PATCH | `/spaces/:id/comments/:id/moderation` | ✅ |
| PATCH | `/spaces/:id/reports/entity/:id` | ✅ |
| PATCH | `/spaces/:id/reports/comment/:id` | ✅ |

### events
Community events with RSVPs, invites, and co-hosts (Agora extension, SDK-derived — not yet
round-tripped against the live SDK, hence 🔶). Visibility is `public | members | invite`
(`members` = space members when `spaceId` is set, else any authed user); the list shows public events
plus the caller's own visible set, single GET enforces the per-row gate (`403 events/not-visible`).
Both the list and single GET also apply the **space-read** gate — an event in a members-reading space
is hidden/`403`s a caller who can't read that space (list ↔ single-GET stay consistent, fail-closed).
RSVP set/withdraw and the guest-list read require the same view access (`403 events/not-visible`).
Removed events are hidden from non-admins. An unknown enum filter (`?type`/`?status`, and RSVP
`?status`) returns `400 events/invalid-filter`. **Manage** (PATCH/DELETE/cancel/invites/hosts) is gated
to a host or project-admin (`403 events/not-host`). RSVP gates: `400 events/rsvp-closed` (cancelled or
past), `events/maybe-not-allowed`, `events/capacity-full` (capacity is enforced atomically under a row
lock). Removing the last host is rejected (`400 events/last-host`); a hidden guest list 403s non-hosts
(`events/guest-list-hidden`).
`POST /events` accepts JSON or `multipart/form-data` (`cover` + `gallery` images → the image pipeline).
| Method | Path | Status |
|---|---|---|
| POST | `/events` (create; JSON or `multipart/form-data` with `cover`/`gallery`; creator auto-added as host) | 🔶 |
| GET | `/events` (list; `page/limit/sortBy(startTime\|going)/sortDir/timeWindow(upcoming\|past\|ongoing)/spaceId/hostId/type/status/startsAfter/startsBefore/locationFilters[latitude\|longitude\|radius]` km) | 🔶 |
| GET | `/events/:eventId` (`?include=user,userRsvp`) | 🔶 |
| PATCH | `/events/:eventId` (host/admin; `removeImageIds` drops gallery files) | 🔶 |
| DELETE | `/events/:eventId` (host/admin; soft-delete) | 🔶 |
| POST | `/events/:eventId/cancel` (host/admin; sets `status=cancelled`) | 🔶 |
| POST | `/events/:eventId/rsvp` (`{ status: going\|maybe\|not_going }`; upsert) | 🔶 |
| DELETE | `/events/:eventId/rsvp` (withdraw own RSVP) | 🔶 |
| GET | `/events/:eventId/rsvps` (`?status=`, `?include=user`; host/admin or `guestListVisible`) | 🔶 |
| POST | `/events/:eventId/invites` (host/admin; `{ userId }`; idempotent) | 🔶 |
| DELETE | `/events/:eventId/invites` (host/admin; `{ userId }`; also drops that user's RSVP) | 🔶 |
| GET | `/events/:eventId/invites` (host/admin only; `?include=user`) | 🔶 |
| POST | `/events/:eventId/hosts` (host/admin; `{ userId }`; idempotent) | 🔶 |
| DELETE | `/events/:eventId/hosts` (host/admin; `{ userId }`; `400 events/last-host`) | 🔶 |

### chat (REST side — realtime is §4)
| Method | Path | Status |
|---|---|---|
| GET | `/chat/conversations` | ✅ |
| POST | `/chat/conversations` | ✅ |
| POST | `/chat/conversations/direct` | ✅ |
| GET | `/chat/conversations/:id` | ✅ |
| GET | `/chat/conversations/:id/preview` | ✅ |
| GET | `/chat/conversations/unread-count` (authoritative badge source → `{ totalUnread, unreadConversationCount }` aggregated across all member conversations; declared above `/:id` so the static segment wins) | ✅ |
| PATCH | `/chat/conversations/:id` | ✅ |
| DELETE | `/chat/conversations/:id` | ✅ |
| DELETE | `/chat/conversations/:id/leave` | ✅ |
| POST | `/chat/conversations/:id/read` | ✅ |
| POST | `/chat/conversations/:id/mute` (self only; body `{ duration: "8h"\|"24h"\|"1w"\|"forever"\|null }`, `null` clears the mute → `{ currentMember }` carrying the caller's own `mutedUntil`/`mutedForever`) | 🔶 |
| GET | `/chat/conversations/:id/members` | ✅ |
| POST | `/chat/conversations/:id/members` | ✅ |
| DELETE | `/chat/conversations/:id/members/:id` | ✅ |
| PATCH | `/chat/conversations/:id/members/:id/role` | ✅ |
| GET | `/chat/conversations/:id/messages` (query: `limit`, `sort`, `parentId`, `before` ISO cursor, **`after` ISO cursor** — reconnect catch-up: `created_at > after` ms-truncated, ascending; `400 chat/invalid-after` on a malformed timestamp) | ✅ |
| POST | `/chat/conversations/:id/messages` (JSON, or `multipart/form-data` with `files` → uploaded files returned in `message.files`) | ✅ |
| PATCH | `/chat/conversations/:id/messages/:id` | ✅ |
| DELETE | `/chat/conversations/:id/messages/:id` | ✅ |
| POST | `/chat/conversations/:id/messages/:id/reactions` | ✅ |
| POST | `/chat/conversations/:id/messages/:id/report` | ✅ |
| GET | `/chat/spaces/:id/conversation` | ✅ |

`/mute` persists `mutedUntil`/`mutedForever` on the caller's own `ConversationMember` row. A
per-conversation push-suppression helper (`isConversationMutedForUser` / `dispatchChatMessagePush` in
`lib/push/index.ts`) is implemented but **currently unreachable** — no chat `message` push-dispatch
call site is wired into the message-send handler yet, so muting today has no observable effect on
push delivery (there's nothing dispatching a `message` push to suppress). Wiring that call site is a
follow-up.

### collections
| Method | Path | Status |
|---|---|---|
| GET | `/collections/root` | ✅ |
| GET | `/collections/:id` | ✅ |
| PATCH | `/collections/:id` (rename/reparent; `useUpdateCollectionMutation`) | ✅ |
| DELETE | `/collections/:id` (delete; sub-collections + entities cascade; `useDeleteCollectionMutation`) | ✅ |
| GET/POST | `/collections/:id/sub-collections` | ✅ |
| GET/POST | `/collections/:id/entities` | ✅ |
| DELETE | `/collections/:id/entities/:id` | ✅ |

### db (custom tables)
| Method | Path | Status |
|---|---|---|
| GET | `/db/:tableName` (list; `page/limit/sortBy/sortDir/filters/includeDeleted`; per-row ownership; `useFetchTableRowsQuery`) | ✅ |
| POST | `/db/:tableName` (create row `{ data }` → `{ row }`) | ✅ |
| PATCH | `/db/:tableName/:rowId` (replace `data` → `{ row }`) | ✅ |
| DELETE | `/db/:tableName/:rowId` (soft-delete; `?force=true` hard-deletes → `{ deleted, soft }`) | ✅ |
| POST | `/db/:tableName/:rowId/restore` (→ `{ row }`) | ✅ |

### app-notifications
| Method | Path | Status |
|---|---|---|
| GET | `/app-notifications` | ✅ |
| GET | `/app-notifications/count` | ✅ |
| PATCH | `/app-notifications/:id/mark-as-read` | ✅ |
| POST/PATCH | `/app-notifications/mark-all-as-read` (SDK uses PATCH → `{ success, markedAsRead }`) | ✅ |

### push-notifications (Agora extension — Web Push / FCM / APNs device registry)
Device registration for push delivery of in-app notifications (Agora addition, not an SDK hook). The
dispatch layer mirrors the **push-worthy allowlist** into a background send whenever an in-app
notification is written — reactions, reaction-milestones, and **all steward events** are suppressed
(in-app only). Web Push (VAPID) is fully wired; FCM HTTP v1 + APNs HTTP/2 are credential-gated
(per-project `project_integrations`, env fallback). The device body is the
`PushDevice` identifier union (native `{platform:ios|android, token}` or web
`{platform:web, subscription:{endpoint, keys:{p256dh, auth}}}`); registration is an idempotent upsert
(native keyed on `(project,user,platform,token)`, web on `(project,user,endpoint)`).
| Method | Path | Status |
|---|---|---|
| POST | `/push-notifications/devices` (auth; register/upsert a device → `204`) | ✅ |
| DELETE | `/push-notifications/devices` (auth; deregister; body identifies the device → `204`) | ✅ |
| POST | `/push-notifications/devices/deregister` (auth; proxy-safe fallback for gateways that strip DELETE bodies → `204`) | ✅ |
| GET | `/push-notifications/vapid-public-key` (**unauthenticated**, rate-limited — fetched pre-sign-in → `{ publicKey: string \| null }`) | ✅ |
| GET | `/push-notifications/preferences` (auth; own row → `{ disabledTypes: PushEventType[] }`, `[]` if unset) | 🔶 |
| PUT | `/push-notifications/preferences` (auth; full-replace upsert, body `{ disabledTypes }`; an unknown `PushEventType` → `400`) | 🔶 |

`disabledTypes` is a per-user **opt-OUT** set over the 20-value `PushEventType` enum (migration
`0060`; see MODELS.md). `dispatchNotificationPush` skips any type in the caller's set before fanning
out to devices.

### match (Agora extension — request contract only, engine deferred)
| Method | Path | Status |
|---|---|---|
| POST | `/match/users` (auth; body `{ mode: passive\|directed, query?, limit?, spaceId?, includeChildSpaces?, includeSampleContent?, excludeSelf? }` — `directed` mode requires a non-empty `query`, else `400`) → `{ results: [] }` | 🔶 |

**Stub.** `useMatchUsers` gets a validated request contract and a clean empty-results response so it
settles without erroring, but the actual facet/embedding matching engine is unimplemented — `results`
is unconditionally `[]`. The real engine is a separate future spec.

### reports
| Method | Path | Status |
|---|---|---|
| POST | `/reports` | ✅ |
| GET | `/reports/pending` | 🔶 |
| GET | `/reports/moderated` | ✅ |

> `GET /reports/pending` + `GET /reports/moderated` are **role-scoped** (Agora admin extension, not
> in the SDK): a deployment **operator** (env `OPERATOR_USER_IDS`/`OPERATOR_EMAILS`, surfaced as
> `AuthUser.isOperator` / the JWT `operator` claim) **or a project owner/admin** (`project_roles`
> grant, surfaced as `AuthUser.isProjectOwner`/`isProjectAdmin` / the JWT `powner`/`padmin` claims)
> sees every report in the project; any other user sees only reports filed against spaces they own or
> moderate. `PATCH /reports/:id/resolve` is likewise project-admin-gated. Both lists paginate
> `{ data, pagination }`.

### search
All search endpoints are **POST** with a JSON body `{ query, limit?, ... }` and return a **bare
array** of `{ similarity, record }` results (NOT a `{ data, pagination }` envelope) — confirmed
against the SDK's `useSearchContent`/`useAskContent`/`useSearchSpaces`/`useSearchUsers`.
| Method | Path | Status |
|---|---|---|
| POST | `/search/content` (semantic across entity/comment/message; Voyage→`match_content` pgvector; honors `sourceTypes`, `spaceId`, `includeChildSpaces?`) → `ContentSearchResult[]` | ✅ |
| POST | `/search/ask` (RAG; SSE stream `token`→`sources`→`done`/`error`; honors the same `spaceId`/`includeChildSpaces?`) | ✅ |
| POST | `/search/spaces` (ILIKE) → `SpaceSearchResult[]` | ✅ |
| POST | `/search/users` (ILIKE) → `UserSearchResult[]` | ✅ |

`includeChildSpaces?: boolean` (with a `spaceId`) resolves `{self ∪ descendants}` via a recursive CTE
(`lib/space-tree.ts` `resolveSpaceSubtree`, migration `0061` — `match_content` gained `p_space_ids`)
and scopes the search to that set instead of the single space.

### storage
| Method | Path | Status |
|---|---|---|
| POST | `/storage` | ✅ |
| POST | `/storage/images` (UploadImageOptions: mode exact-dimensions/aspect-ratio-width\|height/original-aspect/multi-aspect-ratio + format/quality/stripExif/fit/pathParts → `{ fileId, original, variants, metadata }`) | ✅ |

### utils
| Method | Path | Status |
|---|---|---|
| GET | `/utils/get-metadata` (URL/OG metadata fetch) | ✅ |

### social (member-facing garden; Agora extension, not an SDK hook)
Member-facing social-graph surfaces. All routes require an authenticated member JWT and are
config-gated (`graphEnabled` + surface-specific flag in `social_config`; `400 social/<surface>-disabled`)
and infra-gated (`NEO4J_URI` set; `503 social/graph-unavailable`).
| Method | Path | Status |
|---|---|---|
| GET | `/social/weather` (→ `SocialWeather { band, value, trend, cachedAt }`) | ✅ |
| GET | `/social/neighborhood` (own ties only; `?includeInteractions=` overrides `social_config.neighborhoodIncludeInteractions` (default false — adds interaction-only ties); `?includeCoParticipates=` (default false — adds CO_PARTICIPATES co-commenter ties at floor brightness, 0 warmth/friction); response echoes `includesInteractions` + `includesCoParticipates`) | ✅ |
| GET | `/social/constellation` (k-anonymized cluster blobs; seasonally cron-materialized. **Adaptive k-floor:** `social_config.constellationKFloor` = `null` (default) → resolved per project size at materialization by `adaptiveConstellationFloor` (2 for `<50` members, 3 `<100`, 4 `<500`, 5 `≥500`); an integer override is raised to ≥2 and capped at 1000. Hard anonymity floor **2** — a blob always represents ≥2 people. Clusters below the floor are suppressed) | ✅ |
| GET | `/social/transparency` (active tier + enabled flags; readable by members) | ✅ |
| GET | `/settings/social` (project-admin; resolved `social_config`) | ✅ |
| PATCH | `/settings/social` (project-admin; deep-merge `social_config`; cache-invalidated) | ✅ |
| POST | `/admin/social/constellation/recompute` (**project-admin**; forces a synchronous GDS Louvain re-materialization on demand — the config-companion to `PATCH /settings/social`, so whoever can set the k-floor can recompute. Config gate `400 social/constellation-disabled`, infra gate `503 social/graph-unavailable`; → `{ recomputed, constellation }`) | ✅ |

### webhooks (project-admin; server-side admin surface, not an SDK hook)
Replyke-style project webhooks: synchronous `validate` events (host may veto a write → 403) +
fire-and-forget `*.complete` broadcasts. HMAC `X-Signature`/`X-Timestamp` (+ `X-Response-Signature`
on validate replies). Covered events: entity/comment/space/message/user `.created`/`.updated` +
`notification.created`. Config below is admin-gated (profile role `admin`).
| Method | Path | Status |
|---|---|---|
| GET | `/webhooks/config` (→ `{ url, events, hasSecret }`; secret never returned) | ✅ |
| PATCH | `/webhooks/config` (set `url`/`secret`/`events`; cache-invalidated) | ✅ |
| GET | `/settings/feed` (project-admin; resolved feed ranking config, re-rank secret redacted) | ✅ |
| PATCH | `/settings/feed` (project-admin; deep-merge `feed_config`; cache-invalidated) | ✅ |
| POST | `/webhooks/test` (signed test ping → `{ configured, ok, status? }`) | ✅ |

### roles (per-project role grants; server-side admin surface, not an SDK hook)
Per-project role management (`owner | admin | steward`), the within-project tier between member and
the deployment platform-operator. Grants live in `project_roles` and are folded into the access JWT
at mint/refresh (`powner`/`padmin` claims; steward via the existing `steward` claim) — effective on
the grantee's next token refresh. **Viewing** is project-admin-gated (`requireProjectAdmin`); **mutating**
is project-owner-gated (`requireProjectOwner`, which a platform operator also satisfies). The last
`owner` of a project cannot be revoked (`400 roles/last-owner`).
| Method | Path | Status |
|---|---|---|
| GET | `/roles` (project-admin; grantees grouped `{ roles: { owner[], admin[], steward[] } }`) | 🔶 |
| POST | `/roles` (project-owner; `{ userId, role }` → idempotent grant; `404 roles/user-not-found` off-project) | 🔶 |
| DELETE | `/roles/:userId/:role` (project-owner; revoke; `400 roles/last-owner` / `roles/invalid-role`) | 🔶 |

### admin/social — read receipts (operator + corporate tier)
Live per-space read-receipt coverage and per-space opt-in toggle. All routes require a deployment
operator JWT; `400 social/read-receipts-disabled` if the project's `readReceiptsAllowed` flag is off
(community tier).
| Method | Path | Status |
|---|---|---|
| GET | `/admin/social/read-receipts` (operator; live coverage → `SocialReadReceipts { spaces: ReceiptSpace[], asOf }`) | ✅ |
| PATCH | `/admin/social/read-receipts/spaces/:spaceId` (operator; `{ enabled: boolean }` → `{ spaceId, readReceiptsEnabled }`) | ✅ |

---

## 3. Response object models (must match `@replyke/core` interfaces)

Every returned object must match the TS interfaces or the typed hooks break. Full field
lists captured in `docs/MODELS.md` (source: `interfaces/models/`):

`Entity`, `Comment` (+ `GifData`, `TopComment`), `User`/`AuthUser`/`UserFull`,
`Reaction` (+ `ReactionCounts`, 8 `ReactionType`s), `Space`/`SpaceDetailed`/`SpacePreview`,
`SpaceMember`, `Rule`, `Conversation`/`ConversationPreview`, `ConversationMember`,
`ChatMessage`, `Follow`, `Connection` (+ its many response shapes), `Collection`,
`File`/`FileImage`, `Image`, `Mention` (user|space), `Project`,
`Event`/`EventRsvp`/`EventInvite`, `PushDevice`, and the 17-variant
`UnifiedAppNotification` union.

**Reaction types (8):** `upvote, downvote, like, love, wow, sad, angry, funny`.
**v6→v7 note:** `Entity`/`Comment` keep legacy `upvotes[]`/`downvotes[]` arrays AND the v7
`reactionCounts` object + `userReaction`. Reproduce both for compatibility.

---

## 4. 🔴 Socket.io realtime contract (the hard part)

**Not** raw WebSocket and **not** drop-in Supabase Realtime. You must run a **socket.io**
server speaking these exact event names.

**Connection** (`context/chat-context.tsx`):
```js
io(socketUrl, { auth: { token: accessToken }, query: { projectId }, autoConnect: true })
```
`socketUrl` = origin of the SDK's base URL (the env var from §0). Authenticate the socket from
`auth.token`, scope it by `query.projectId`.

**Server → Client events** (`types/socket.ts` — `ServerToClientEvents`):
| Event | Payload |
|---|---|
| `message:created` | `ChatMessage` |
| `message:updated` | `{ messageId, conversationId, content, gif, mentions, metadata, editedAt }` |
| `message:deleted` | `{ messageId, conversationId, userDeletedAt }` |
| `message:removed` | `{ messageId, conversationId }` (moderation) |
| `message:reaction` | `{ messageId, conversationId, emoji, userId, delta: 1\|-1, reactionCounts }` |
| `thread:reply_count` | `{ messageId, conversationId, threadReplyCount }` |
| `typing:start` | `{ userId, conversationId }` |
| `typing:stop` | `{ userId, conversationId }` |
| `member:joined` | `{ conversationId, member: ConversationMember }` |
| `member:left` | `{ conversationId, userId }` |
| `conversation:updated` | `Partial<Conversation> & { id }` |
| `conversation:deleted` | `{ conversationId }` |
| `conversation:created` | `ConversationPreview` (zero-state: `unreadCount: 0`, `lastMessage: null`, `otherMembers`; room `user:<projectId>:<userId>`. Emitted to each new member on direct/group create — Agora addition, see §4 note) |
| `notification:created` | `UnifiedAppNotification` (full shaped row; room `user:<projectId>:<userId>`, auto-joined on connect) |
| `connect` / `disconnect` | (built-in) |

**Client → Server events** (`ClientToServerEvents`):
| Event | Payload |
|---|---|
| `join:conversation` | `{ conversationId }` |
| `leave:conversation` | `{ conversationId }` |
| `typing:start` | `{ conversationId }` |
| `typing:stop` | `{ conversationId }` |

**Room semantics:** client emits `join:conversation` to subscribe; server fans out
typing/member events to that conversation room. Read state via REST
`POST /chat/conversations/:id/read`. Separately, every authenticated socket is **auto-joined**
server-side to its own `user:<projectId>:<userId>` room (no client emit) — the server fans out
`notification:created` there so the bell/badge updates live for every notification type. Across
multiple API replicas this fan-out crosses processes when `REDIS_URL` is set (socket.io Redis
adapter); otherwise it stays single-process.

**Live inbox (Agora addition beyond the stock contract).** `message:created` fans out to the
**union** of the conversation room AND every active member's `user:<projectId>:<userId>` room — so a
member viewing the inbox (but not in the thread room) still receives the message and can reorder/bump
unread without opening the thread (socket.io dedupes a socket present in both rooms → one delivery).
On a new direct/group conversation the server emits **`conversation:created`** (a zero-state
`ConversationPreview`) to each added member's user room (excluding the actor, who has it from the REST
response), so a brand-new chat appears on the recipient's list instantly — the get-or-create direct
branch does NOT re-emit when the conversation already existed. Connection request/accept run through the
same `notification:created` path (no dedicated `connection:*` events). These ride the per-user room that
also carries notifications; the stock Replyke SDK simply ignores `conversation:created`.

> **Secure chat (Agora extension — not an SDK contract surface).** The end-to-end-encrypted secure-chat
> surface lives outside this manifest; its full REST + realtime contract is in
> [`docs/SECURE_CHAT.md`](SECURE_CHAT.md). Two notes that touch the shape above: its REST stays at
> `/v7/:projectId/secure-chat/*` (unchanged), but as of the service split it is served by the **separate
> `@agora/secure-chat` process** (a reverse proxy routes that prefix to it, not to the API). Its realtime
> is a **distinct socket.io namespace `/secure`** with its **own event names**, and — because it is a
> separate process — it runs on the engine.io **path `/secure-socket/`** (not the default `/socket.io/`),
> so the secure client connects with
> `io(`${secureChatOrigin}/secure`, { path: "/secure-socket/", auth, query })`. None of this changes the
> plaintext-chat contract documented here.

---

## 5. Entity feed filters (query params on `GET /entities`)

From `interfaces/entity-filters/`:
- **content**: `hasContent`, `includes`, `doesNotInclude`
- **title**: `hasTitle`, `includes`, `doesNotInclude`
- **keywords**: `includes[]`, `doesNotInclude[]`
- **attachments**: `hasAttachments`
- **metadata**: `includes`, `includesAny[]`, `doesNotInclude`, `exists[]`, `doesNotExist[]`
- **location**: `{ latitude, longitude, radius }` (GeoJSON Point on entity)
- plus sort: `createdAt` (first-class chronological, honors `sortDir`) and the score-based
  `hot/top/controversial/decay/gravity/wilson/bayesian`; `new` is the deprecated `createdAt`-desc
  alias (emits `Deprecation: true`, §1). Plus `spaceId`, pagination, `include[]`
  (`space|user|topComment|saved|files`)

---

## 6. Difficulty ranking (honest)

| Layer | Difficulty | Why |
|---|---|---|
| REST CRUD (entities/comments/follows/collections/spaces) | 🟢 easy–med | straight from spec; Supabase handles data |
| Pagination / error envelopes | 🟢 easy | formatting conventions |
| Auth token rotation + RS256 external | 🟡 med | rotation/reuse/grace must be faithful |
| Feed ranking, vote tallies, notification fan-out | 🟡 med | real business logic (triggers + RPC) |
| Socket.io chat realtime | 🔴 hardest | stateful, event-exact, rooms + read state + typing |

**Recommendation:** build REST + auth + schema first; stub the chat module behind a flag
and add the socket.io server last.
