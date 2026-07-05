# Feature Migration — SDK v7.6.2 → Agora server

> ✅ **SHIPPED (0.16.0) — retained as historical record.** All five server-facing features described
> below (§1 Push notifications, §2 Events, §3 Comment sorting, §4 Entity feed sorting, §5 Live
> conversation list) have since been implemented and released in **0.16.0** (see `CHANGELOG.md`; events
> in migration 0053, push devices in 0055). This document is kept as the historical **implementation
> plan** that drove that work — the endpoint/table/socket details are accurate to what was built, but
> the "must implement" framing, effort estimates, and open questions are answered. For the live
> contract, read `docs/MANIFEST.md` + `docs/MODELS.md`.

**Audience:** Agora server team
**From:** Agora SDK (`@agora-sdk/*`)
**Status:** ✅ Shipped in 0.16.0 (originally authored as a proposal — the **SDK side** was already built
and shipped as v1.4.0). This document described what the **server** had to implement so the new client
features work end-to-end; that server work is now done.

> Filename note: created as `FEATURE_MIGRATION.md` (the request said `FETURE_`; assumed a typo —
> rename if you genuinely want the original spelling).

---

## What this covers (and what it doesn't)

The recent **upstream v7.6.2 sync** (SDK commit `61f86be`, released as Agora v1.4.0) pulled in a
large batch of new client functionality. This doc inventories the **server-facing contract** for
each new feature: endpoints, query params, request/response shapes, socket events, new tables, and
open questions — every claim cited to SDK source as `path:line` (the team will be reading the code).

**Out of scope — the earlier v7.4.2 "sync" was purely the Replyke→Sublay rename**, no new features,
so nothing there needs server work. The custom-tables / reputation / mutual-spaces / chat-reply
surfaces predate this window and are assumed already implemented server-side.

**Adjacent, documented separately:** user↔user in-app **comment notifications** (generation + a
`notification:created` socket push) are specced in their own doc — see **§6 Cross-references**. That
work is not part of the v7.6.2 delta but completes the notification story.

### Conventions used throughout

- **Base URL:** the SDK's axios base is `{baseUrl}`, default `http://localhost:4000/v7`
  (`packages/core/src/config/runtime.ts`). Every path below is appended to it.
- **Project scoping:** all REST paths are prefixed with `/:projectId/…`.
- **Auth:** authenticated calls send `Authorization: Bearer <accessToken>`. The server returns
  **401** on token expiry (the SDK auto-refreshes on 401) and **403** for authorization denials —
  do **not** use 403 for expiry.
- **Pagination envelopes vary by domain** (documented per endpoint): the standard
  `PaginatedResponse<T>` = `{ data: T[], pagination: { page, pageSize, totalPages, totalItems, hasMore } }`,
  but chat conversations use a **cursor** envelope and connections use yet another shape (see
  `MODELS.md`).
- **Models:** field-level response shapes already live in
  [`MODELS.md`](./MODELS.md); new models introduced here (push devices, events) should be added there
  once implemented.

### At a glance

| # | Feature | Server effort | New tables | Socket work |
|---|---|---|---|---|
| 1 | Push notifications | **Large** (FCM/APNs/Web Push send infra) | `push_devices` | none |
| 2 | Events (RSVPs · invites · hosts) | **Large** (new domain, ~16 endpoints) | `events`, `event_rsvps`, `event_invites`, (`event_hosts`) + `files.event_id` | none |
| 3 | Comment sorting | Small (query params + ordering) | none | none |
| 4 | Entity feed sorting | Small (`createdAt` + `new` alias) | none | none |
| 5 | Live conversation list | **Medium** (cursor list + socket fan-out) | none (needs composite index) | **yes** |

---

## 1. Push Notifications

Brand-new opt-in feature. The SDK registers/deregisters an OS push token per device; the **server is
solely responsible for actually sending** FCM/APNs/Web Push to offline users.

### 1.1 REST endpoints

All under `/:projectId/push-notifications/`.

#### Register a device
```
POST /:projectId/push-notifications/devices
```
- **Auth:** required (`Authorization: Bearer`; `store/api/baseApi.ts:22`). Hook also guards locally,
  throwing if `projectId` or `user` is absent (`hooks/push/usePushRegistration.ts:41-43`).
- **Query params:** none.
- **Body** — the `PushDeviceIdentifier` union, spread directly into the body
  (`store/api/pushApi.ts:9-13`, `interfaces/PushTokenAdapter.ts:11-13`):
  ```ts
  // iOS / Android
  { platform: "ios" | "android"; token: string }
  // Web
  { platform: "web"; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }
  ```
- **Response:** `void` — `200`/`204`, no body (`store/api/pushApi.ts:8`).
- **Must be an upsert:** dedupe native on `(project_id, user_id, platform, token)`, web on
  `(project_id, user_id, subscription.endpoint)`.

#### Deregister a device
```
DELETE /:projectId/push-notifications/devices
```
- **Auth:** required. **Body:** identical `PushDeviceIdentifier` union — the SDK re-calls
  `adapter.getDeviceIdentifier()` and sends the result as the DELETE body
  (`hooks/push/usePushRegistration.ts:63-69`, `store/api/pushApi.ts:16-23`).
- If the adapter returns `null`, the SDK makes **no** HTTP call
  (`hooks/push/usePushRegistration.ts:66-67`). Make delete **idempotent** (`200`/`204` even if the
  token is unknown).

#### Fetch VAPID public key (web only)
```
GET /:projectId/push-notifications/vapid-public-key
```
- **Intentionally UNAUTHENTICATED** — the browser must call it before sign-in to run
  `pushManager.subscribe()` (`packages/react-js/src/PushTokenAdapter.ts:38-40`). The VAPID public key
  is not secret. **Rate-limit it** (it's an unauthenticated, project-id-bearing endpoint).
- **Response:** `{ publicKey: string | null }` — URL-safe Base64 VAPID public key; the web adapter
  feeds it to `PushManager.subscribe({ applicationServerKey })` (`PushTokenAdapter.ts:44-46`).

### 1.2 Native token semantics

- **React Native** (`@react-native-firebase/messaging`): iOS → `getAPNSToken()` (raw APNs token);
  Android → `getToken()` (FCM token) (`packages/react-native/src/PushTokenAdapter.ts:20-25`).
- **Expo** (`expo-notifications`): uses `getDevicePushTokenAsync()` (**raw APNs/FCM token**), *not*
  `getExpoPushTokenAsync()` — the server dispatches directly to APNs/FCM with the project's own
  credentials, not via Expo's relay (`packages/expo/src/PushTokenAdapter.ts:4-7,14-18`).

**Implication:** the server must hold the project's own **FCM** credentials (server key /
service-account JSON) and **APNs** credentials (`.p8` key + team/key IDs, or cert), and a **VAPID**
keypair for web.

### 1.3 Server responsibilities (beyond storing tokens)

1. Generate/store a **VAPID keypair** (per-project ideally; one global keypair acceptable). Serve the
   public key unauthenticated; keep the private key server-side.
2. Store **FCM + APNs** credentials per project (secure storage).
3. **Dispatch** on relevant domain events: look up all of the recipient's devices and send via FCM
   HTTP v1 (`android`), APNs HTTP/2 (`ios`), and Web Push (RFC 8030 + VAPID RFC 8292) for `web`.
4. **Prune stale tokens:** on FCM/APNs "not registered" / Web Push `410 Gone`, delete the row.
5. **Multi-device:** send to *all* of a user's registered devices.

### 1.4 New table: `push_devices`

```
push_devices
  id            uuid         PK default gen_random_uuid()
  project_id    uuid         NOT NULL FK → projects(id) ON DELETE CASCADE
  user_id       uuid         NOT NULL FK → users(id)    ON DELETE CASCADE
  platform      text         NOT NULL CHECK (platform IN ('ios','android','web'))
  token         text         NULL   -- iOS APNs / Android FCM token
  subscription  jsonb        NULL   -- web: { endpoint, keys: { p256dh, auth } }
  created_at    timestamptz  NOT NULL DEFAULT now()
  updated_at    timestamptz  NOT NULL DEFAULT now()

  CHECK ( (platform IN ('ios','android') AND token IS NOT NULL AND subscription IS NULL)
       OR (platform = 'web' AND subscription IS NOT NULL AND token IS NULL) )

  UNIQUE (project_id, user_id, platform, token)            WHERE platform IN ('ios','android')
  UNIQUE (project_id, user_id, (subscription->>'endpoint')) WHERE platform = 'web'
```
DELETE matches native by `(project_id, user_id, platform, token)`, web by
`(project_id, user_id, subscription->>'endpoint')`.

### 1.5 Open questions
1. VAPID keypair scope — per-project or global?
2. Where do project owners supply FCM/APNs credentials — existing `project` integrations row or a new
   secure store?
3. Which domain events trigger a push dispatch? (taxonomy decision — maps to events already fired
   server-side but not yet wired to push)
4. `DELETE` with a body is legal but some proxies strip it — confirm the gateway preserves it, else
   switch to a query string or a `…/devices/deregister` POST.
5. Orphaned tokens after user deletion (cascade handles it, but confirm).

---

## 2. Events (RSVPs · Invites · Hosts)

A **whole new domain**: events with RSVPs, invitee lists, and multi-host management. Pure REST (no
sockets). Source of truth: `packages/core/src/interfaces/models/Event.ts` + `hooks/events/*`.

### 2.1 Data model

```ts
// interfaces/models/Event.ts:5-8
type EventType       = "online" | "physical" | "hybrid";
type EventVisibility = "public" | "members" | "invite";
type EventStatus     = "active" | "cancelled";
type RsvpStatus      = "going" | "maybe" | "not_going";

// interfaces/models/Event.ts:16-51
interface Event {
  id: string; shortId: string; projectId: string;
  userId: string | null; user?: User | null;          // creator
  title: string; description: string | null;
  startTime: string;  endTime: string | null;  timezone: string | null;  // ISO 8601 / IANA tz
  type: EventType;
  url: string | null;                                  // online/hybrid
  venueName: string | null; address: string | null;   // physical/hybrid
  location: { type: "Point"; coordinates: [number, number] } | null;  // [lng, lat]
  spaceId: string | null; space?: Space | null;        // soft ref, no enforced FK
  visibility: EventVisibility; status: EventStatus;
  allowMaybe: boolean; guestListVisible: boolean;
  capacity: number | null;                             // null = unlimited
  hostIds: string[];
  coverImageId: string | null; files?: File[];         // gallery via include="files"
  rsvpCounts: { going: number; maybe: number; not_going: number };  // computed aggregate
  userRsvp?: RsvpStatus | null;                        // include="userRsvp" + auth
  metadata: Record<string, any>;
  createdAt: string; updatedAt: string; deletedAt: string | null;
}

// interfaces/models/Event.ts:53-61 / 63-71
interface EventRsvp   { id; eventId; userId; user?; status: RsvpStatus; createdAt; updatedAt }
interface EventInvite { id; eventId; userId; user?; invitedAt; createdAt; updatedAt }
```

### 2.2 REST endpoints

#### Event CRUD

| Method | Path | Body | Response | Source |
|---|---|---|---|---|
| POST | `/:projectId/events` | create payload (below) | `Event` (201) | `useCreateEvent.tsx:155-165` |
| GET | `/:projectId/events/:eventId` | `?include=user,space,files,userRsvp` | `Event` | `useFetchEvent.tsx:30` |
| GET | `/:projectId/events` | query params (below) | `PaginatedResponse<Event>` | `useFetchManyEvents.tsx:131-134` |
| PATCH | `/:projectId/events/:eventId` | partial update (below) | `Event` | `useUpdateEvent.tsx:116-128` |
| DELETE | `/:projectId/events/:eventId` | — | `204` | `useDeleteEvent.tsx:22` |
| POST | `/:projectId/events/:eventId/cancel` | — | `Event` (`status:"cancelled"`) | `useCancelEvent.tsx:23` |

**Create body** (JSON; or `multipart/form-data` when images present):
```ts
{
  title: string; startTime: string; type: EventType;     // required
  description?; endTime?; timezone?; url?; venueName?; address?;
  location?: { latitude: number; longitude: number };
  spaceId?; visibility? /* default "public" */; capacity?;
  allowMaybe?; guestListVisible?;
  hostIds?: string[];                                     // creator auto-added
  metadata?: Record<string, any>;
}
```
Multipart adds: `cover` (File) + `cover.options` (JSON `UploadImageOptions`), `gallery` (File[]) +
`gallery.options` (JSON). **Update** is the same scalar set, all optional, **minus `hostIds`** (hosts
are managed only via the `/hosts` sub-resource), plus `removeImageIds: string[]`.

**List query params** (`useFetchManyEvents.tsx:131-134`):
```
page (1) · limit (10)
sortBy = "startTime" | "going"          sortDir = "asc" | "desc"
timeWindow = "upcoming" | "ongoing" | "past"
startsAfter / startsBefore (ISO)        spaceId · hostId · type · status
myRsvp = comma-sep RsvpStatus           include = comma-sep associations
locationFilters[latitude|longitude|radius]
titleFilters[hasTitle|includes|doesNotInclude]
descriptionFilters[hasDescription|includes|doesNotInclude]
```

#### RSVP

| Method | Path | Body | Response | Source |
|---|---|---|---|---|
| POST | `/:projectId/events/:eventId/rsvp` | `{ status: RsvpStatus }` | `Event` | `useSetRsvp.tsx:21-24` |
| DELETE | `/:projectId/events/:eventId/rsvp` | — | `Event` | `useWithdrawRsvp.tsx:20-23` |
| GET | `/:projectId/events/:eventId/rsvps` | `?page=&limit=&status=` | `{ data: EventRsvp[], pagination }` | `useFetchEventRsvps.tsx:38-42` |

RSVP set is an **upsert** (one row per user/event). Reject `maybe` with `400` when `allowMaybe:false`
(test-confirmed). The RSVP list is host-visible always; non-hosts only when `guestListVisible:true`,
else `403` (`useFetchEventRsvps.tsx:16-18`).

#### Invitees (host-only; idempotent add)

| Method | Path | Body | Response | Source |
|---|---|---|---|---|
| POST | `/:projectId/events/:eventId/invites` | `{ userId }` | `Event` | `useAddInvite.tsx:22-26` |
| DELETE | `/:projectId/events/:eventId/invites` | `{ userId }` | `Event` | `useRemoveInvite.tsx:21-25` |
| GET | `/:projectId/events/:eventId/invites` | `?page=&limit=` | `{ data: EventInvite[], pagination }` | `useFetchInvitees.tsx:30-34` |

`userId` is an internal user id (not foreignId). Removing an invite also drops the invitee's RSVP and
revokes access to `visibility:"invite"` events (`useRemoveInvite.tsx:9`). Invite list is host-only
(`403` otherwise, `useFetchInvitees.tsx:13`).

#### Hosts

| Method | Path | Body | Response | Source |
|---|---|---|---|---|
| POST | `/:projectId/events/:eventId/hosts` | `{ userId }` | `Event` (updated `hostIds`) | `useAddHost.tsx:21-25` |
| DELETE | `/:projectId/events/:eventId/hosts` | `{ userId }` | `Event` (updated `hostIds`) | `useRemoveHost.tsx:21-25` |

Removing a host must be **rejected if it would leave zero hosts** (`useRemoveHost.tsx:9`).

### 2.3 New tables

- **`events`** — all columns from §2.1 (snake_case; `location` as GeoJSON/PostGIS Point; `metadata`
  jsonb; soft-delete `deleted_at`). `rsvp_counts` are **computed**, not stored. `space_id` is a soft
  reference (no FK).
- **`event_rsvps`** — `(id, event_id, user_id, status, created_at, updated_at)`, UNIQUE
  `(event_id, user_id)`.
- **`event_invites`** — `(id, event_id, user_id, invited_at, created_at, updated_at)`, UNIQUE
  `(event_id, user_id)`.
- **`event_hosts`** (optional) — join table `(event_id, user_id, created_at)`; the SDK only exposes
  `hostIds: string[]` on `Event`, so a Postgres array column or a join table both satisfy the
  contract (join table recommended for add/remove + "events where userId is host" queries).
- **`files.event_id`** — add a nullable `event_id` FK to the existing `files` table for event gallery
  images (the SDK uploads "files with eventId + position", `useCreateEvent.tsx:28`).

### 2.4 Open questions
1. **Authorization rules** — who can update / delete / cancel an event (creator, any host, admin)?
2. Who can add/remove **hosts** and **invites**? (server already `403`s in tests — codify the rule)
3. **Capacity enforcement** — when `capacity` is set, reject `going` past the cap? Does `maybe` count?
4. **`allowMaybe:false` / closed RSVPs** — confirm `400` covers both no-`maybe` and past/cancelled.
5. **`visibility:"members"`** — members of the `spaceId`, or of the project?
6. **`visibility:"invite"`** — confirm `403` on fetch/list for non-invitees.
7. **`locationFilters` radius unit** (km vs mi) and PostGIS vs bounding box.
8. **`hostIds` storage** — array column vs `event_hosts` join table.
9. **`coverImageId`** — a `files` row, or a separate image record?

---

## 3. Comment Sorting

New comment sort surface: a `createdAt` sortBy + `sortDir`, a `controversial` sort, and deprecation
of `new`/`old`. The server changes are query-param + ordering only.

### 3.1 Endpoint & params
```
GET /:projectId/comments
```
Built in `useFetchManyComments.tsx:78-84`. Always-sent: `sortBy`, `page` (1-based; SDK throws on
`page===0`, `:48`), `limit` (10 default; 15 in comment section; 5 for replies, `useReplies.tsx:69`).
Conditional (sent only when truthy): `sortDir`, `entityId`, `userId`, `parentId` (reply threads),
`sourceId`, `spaceReputationId`, `spaceReputationDescendants`, `include` (CSV)
(`useFetchManyComments.tsx:66-76`).

- **`sortBy`** (`interfaces/CommentsSortByOptions.ts:9-13`): `"createdAt" | "top" | "controversial" |
  "new" | "old"`. **Note:** there is **no `hot`** for comments (unlike entities).
- **`sortDir`** (`useFetchManyComments.tsx:14`): `"asc" | "desc"`, client default `"desc"`
  (`useFetchManyCommentsWrapper.tsx:48`, `useEntityComments.tsx:54`, `useCommentSectionData.tsx:117`).
- **Default `sortBy` differs by call site:** `createdAt` for entity comment lists / generic wrapper
  (`useEntityComments.tsx:53`, `useFetchManyCommentsWrapper.tsx:47`); **`top`** for the full comment
  section UI (`useCommentSectionData.tsx:115`).

### 3.2 Server semantics
- **`createdAt`** — chronological; `sortDir` controls direction (`desc`=newest first). Replaces
  `new`/`old`. (`CommentsSortByOptions.ts:1-6`)
- **`top`** — score/reaction ranking (existing behavior; formula server-defined).
- **`controversial`** — declared in the type but **no algorithm specified anywhere in the SDK**.
  Server must define it (e.g. Reddit-style `(up+down)/|up−down+ε|` or Wilson). **Confirm with product.**
- **`new` → `createdAt DESC`**, **`old` → `createdAt ASC`** — accept identically, but **emit
  deprecation headers** (the JSDoc explicitly says so; removed in v8). Header format is the server's
  choice (RFC 8594 `Deprecation` + `Sunset`, or `X-Deprecated`).

### 3.3 `sortDir` scope
The JSDoc consistently scopes `sortDir` to `sortBy:"createdAt"` (`useFetchManyComments.tsx:13`, etc.),
but the SDK sends it whenever truthy regardless of `sortBy`. **Honor `sortDir` for `createdAt`**; it's
safe to ignore it (no-op) for `top`/`controversial`.

### 3.4 Open questions
1. Define the **`controversial`** algorithm.
2. **`hot`** isn't sent by any client code — drop server support / treat as planned-v8?
3. Default to `desc` when `sortDir` absent and `sortBy=createdAt`.
4. Exact **deprecation header** format + `Sunset` date (v8 target).

---

## 4. Entity Feed Sorting

The v7.6.2 upstream addition is small: a first-class `createdAt` sortBy plus a deprecated `new`
alias. The rest of the rich sort/rank surface is **Agora's existing ranking engine** (cross-reference
only — not new work).

### 4.1 Endpoint & params
```
GET /:projectId/entities
```
Built via `buildQueryParams` (`store/api/entityListsApi.ts:192-221`; strips `undefined`, omits
`followedOnly` when false; only `sourceId`/`spaceId` forward explicit `null`). Params: `page`,
`limit` (10 default, `useEntityList.ts:149`), `sortBy`, `sortByReaction` (one of the 8 reaction
types; default `upvote`; used by `top`/`controversial`), `sortDir` (`asc|desc`), `sortType`
(`auto|numeric|text|boolean|timestamp`), `timeFrame`, `userId`, `followedOnly`, `sourceId`,
`spaceId`, `spaceReputationId`, `spaceReputationDescendants`, `include`, the bracket-serialized
`keywords/metadata/title/content/attachments/location Filters[...]`, plus the Agora ranking scalars
`rankParams`, `rankAnchor`, `rerank`.

**`sortBy` values** (`interfaces/EntityListSortByOptions.ts:18-30`):

| Value | Origin | Status |
|---|---|---|
| `createdAt` | upstream | **NEW v7.6.2** — canonical chronological |
| `new` (`DeprecatedNewSortBy`) | upstream | **NEW v7.6.2** — deprecated alias for `createdAt` |
| `hot` | upstream | existing — time-decayed engagement |
| `top` | upstream | existing — reaction count (by `sortByReaction`) |
| `controversial` | upstream | existing — reaction variance |
| `decay` / `gravity` / `wilson` / `bayesian` | **Agora custom** | pre-existing ranking engine |
| `metadata.<field>` | upstream | sort by dot-path metadata field (validated `:39-44`) |

### 4.2 New vs existing
- **NEW (do this):** `createdAt` (`:19`) and the `new` alias (`:16`, `:11-15`). The JSDoc says the
  server "still accepts `new` (identical to `createdAt`) but responds with deprecation headers."
- **Existing Agora surface (don't re-spec here):** `decay/gravity/wilson/bayesian` (`:26-29`),
  `rankParams` (JSON tunables), `rankAnchor` (decay-clock pin, **echoed back** in the response for
  cursor stability), `rerank` (re-rank webhook opt-in) — `entityListsApi.ts:100-106,208-210`. These
  are passed directly into `triggerFetchEntities` (not stored in slice state).

### 4.3 Server semantics
- **`createdAt`** — order by `created_at`; default `desc` when `sortDir` absent (matches old `new`).
  Supports `sortDir:"asc"` — the whole point of replacing the directional `new`.
- **`new`** — behave identically to `createdAt DESC` + emit deprecation headers (RFC 8594; `Sunset`
  → v8). Drop at v8.
- **`sortDir` for score algos** — only `createdAt` and `metadata.<field>` have meaningful ascending
  variants; behavior of `sortDir:asc` on score algos is SDK-undefined (server should ignore/clamp and
  document it). Client default `sortDir` is `null` (`useEntityList.ts:188`) → server default applies.
- **Response:** `PaginatedResponse<Entity>` (`entityListsApi.ts:157`).

### 4.4 Open questions
1. Exact **deprecation header** spec + `Sunset` date for `new`.
2. `sortDir=asc` on score-based algos — ignore, clamp, or `400`?
3. Confirm `createdAt` (camelCase API) maps to `created_at` column.
4. Confirm where **`rankAnchor`** is echoed in the response envelope (top-level alongside
   `data`/`pagination`?).
5. `rerank` webhook — sync (blocking) or async? (SDK has no timeout/retry.)

---

## 5. Live Conversation List

Makes the chat **inbox** live: cursor-paginated list, socket-driven reordering/unread, and
reconnect reconciliation. Requires **socket** work, not just REST.

### 5.1 REST endpoints

#### Conversation list (paginated inbox)
```
GET /:projectId/chat/conversations
```
`useConversations.tsx:76`. Params: `limit` (hard-coded **20**), `types` (CSV subset of
`direct,group,space`; omit = all), `cursor` (= `lastMessageAt` of last item), `cursorCreatedAt`
(= `createdAt` of last item, tiebreaker). Keyset pagination on
**`(lastMessageAt DESC NULLS LAST, createdAt DESC)`**; cursor derived client-side
(`useConversations.tsx:86-94`).

**Response:** `{ conversations: ConversationPreview[], hasMore: boolean }` (note the cursor envelope,
not the standard `PaginatedResponse`). `ConversationPreview` = `Conversation` (see `MODELS.md:54-58`)
plus (`interfaces/models/Conversation.ts:29-39`):
```ts
unreadCount: number;                 // messages after currentMember.lastReadAt
lastMessage: ChatMessage | null;     // truncated to 100 chars
otherMembers?: Pick<User,"id"|"name"|"username"|"avatar">[];  // ≤5 active non-self; direct/group
                                     // only; empty for space chats (Conversation.ts:38)
```

#### Single preview
```
GET /:projectId/chat/conversations/:conversationId/preview
```
`useFetchConversationPreview.tsx:32-35`. Returns one `ConversationPreview`. Called by
`ChatProvider.fetchAndInsertPreview` (`chat-context.tsx:246-250`) when a socket event references a
conversation not in the loaded list; deduped via an in-flight set (`chat-context.tsx:137,241`).

#### Authoritative unread summary
```
GET /:projectId/chat/conversations/unread-count
```
`chat-context.tsx:204-213`. Returns `{ totalUnread: number, unreadConversationCount: number }`
aggregated across **all** member conversations. Called on mount (`:277`) and on every reconnect after
the first (`:305-309`). Canonical badge source — the client refuses to infer it from not-loaded
conversations (`chatSlice.ts:218-222`).

#### Adjacent (for completeness)
| Method | Path | Body | Response | Source |
|---|---|---|---|---|
| POST | `/:projectId/chat/conversations/direct` | `{ userId }` | `Conversation` | `useCreateDirectConversation.tsx:27` |
| POST | `/:projectId/chat/conversations` | `{ type:"group", name?, metadata?, memberIds? }` | `ConversationPreview` | `useConversations.tsx:169` |
| GET | `/:projectId/chat/conversations/:id` | — | `Conversation` | `useFetchConversation.tsx:22` |
| POST | `/:projectId/chat/conversations/:id/read` | `{ messageId }` | 2xx | `useMarkConversationAsRead.tsx:34` |

`POST /direct` returns the base `Conversation` (the creator's inbox row arrives via
`conversation:created`); group `POST` returns a `ConversationPreview` (optimistically prepended,
`useConversations.tsx:177`).

### 5.2 Socket events (inbox-driving)

Connection (one per user/project): `io(getSocketUrl(), { auth:{token}, query:{projectId},
autoConnect:true })` (`chat-context.tsx:287-291`). Server derives `userId` from the token.

**Server → client (drive the inbox):** (`types/socket.ts`, handlers in `chat-context.tsx`)

| Event | Payload | Inbox effect | Source |
|---|---|---|---|
| `conversation:created` | `ConversationPreview` | insert + re-sort; falls back to fetch if `unreadCount` missing | `socket.ts:64`, `chat-context.tsx:473-480` |
| `message:created` | full `ChatMessage` | patch `lastMessageAt`/`lastMessage` + re-sort; bump `unreadCount` unless active; if not loaded → `fetchAndInsertPreview` + debounced unread refetch | `socket.ts:11`, `chat-context.tsx:317-345` |
| `conversation:updated` | `Partial<Conversation> & { id }` | patch list row | `socket.ts:59`, `chat-context.tsx:462-467` |
| `conversation:deleted` | `{ conversationId }` | remove + adjust counters | `socket.ts:62`, `chat-context.tsx:495-498` |
| `member:left` | `{ conversationId, userId }` | if self → remove + reconcile | `socket.ts:53-56`, `chat-context.tsx:486-490` |

**Not inbox-driving** (thread-view only): `message:updated/deleted/removed/reaction`,
`thread:reply_count`, `typing:start/stop`, `member:joined`.

**Client → server** (`socket.ts:69-74`): `join:conversation` / `leave:conversation` (on opening/
closing a thread), `typing:start/stop`. **None of these are emitted for the inbox** — see rooms below.

### 5.3 Reconnect reconciliation
On every `socketConnected` false→true transition **after the first** (`useConversations.tsx:145-158`):
1. `refresh()` — reset cursors, reload **page 1** (`limit=20`), fully replacing the Redux list
   (deep pagination is abandoned).
2. `ChatProvider` refetches `GET …/unread-count` (`chat-context.tsx:305-309`) to reset the badge.

**Server must guarantee:** list ordered `lastMessageAt DESC NULLS LAST, createdAt DESC` at request
time (no stale read); `unreadCount` fresh vs `currentMember.lastReadAt`; `lastMessage` is the true
latest (≤100 chars); `unread-count` aggregates across **all** conversations (the client only reloads
page 1, so the badge must cover paginated-out rows).

### 5.4 Room / delivery semantics
Two-tier rooms:
- **User room** (e.g. `user:{userId}`, project-scoped) — auto-joined on connect from the token.
  Delivers `conversation:created`, `conversation:deleted`, self `member:left`, **and `message:created`
  to all members** (so inbox-only observers update without joining the thread room).
- **Conversation room** (e.g. `conversation:{conversationId}`) — joined via `join:conversation` when a
  thread is open. Delivers thread-view events + `message:created` to active viewers.

**Critical:** `message:created` must fan out to BOTH the conversation room (active viewers) **and** the
per-member user rooms (inbox observers). The client never joins conversation rooms for the inbox.

### 5.5 Open questions
1. Is `message:created` currently emitted to **user rooms** (all members) or only the conversation
   room? The SDK needs the former for the inbox.
2. Canonical **user-room name** + confirm the server auto-joins it on connect (no client subscribe
   event exists).
3. `conversation:created` payload must always include `unreadCount` (client branches on its presence,
   `chat-context.tsx:474`) — ideally `otherMembers` + `lastMessage` too. Same query as the preview
   endpoint?
4. Route ordering: ensure `…/unread-count` and `…/:id/preview` don't collide with `…/:conversationId`.
5. Composite index on `(lastMessageAt, createdAt)` for keyset stability — in place?
6. On token rotation the client does `socket.disconnect().connect()` (`chat-context.tsx:536-539`) —
   does the server re-join conversation rooms on the fresh handshake, or must the client re-emit
   `join:conversation`?
7. Is `otherMembers` populated equally by the list endpoint, the preview endpoint, and
   `conversation:created`?
8. Should `POST /direct` return a `ConversationPreview` so the creator can optimistically insert,
   instead of waiting for `conversation:created`?

---

## 6. Cross-references

- **In-app comment notifications** (generation of `entity-comment` / `comment-reply` /
  `comment-mention` rows + a `notification:created` socket push): specced separately in the SDK repo
  at `agora-sdk/docs/superpowers/specs/2026-06-28-server-comment-notifications-spec.md`. Not part of
  the v7.6.2 delta, but it pairs naturally with **§5** (same socket) and **§1** (push delivery of the
  same events).
- **Response models:** [`MODELS.md`](./MODELS.md) — add `Event`/`EventRsvp`/`EventInvite` and the
  `push_devices` shape there once built.
- **SDK divergences & sync model:** `agora-sdk/SYNCING.md` and `agora-sdk/CLAUDE.md` (esp. the
  entity-ranking divergence #5 referenced in §4).

## 7. Suggested sequencing

1. **Comment + entity sorting (§3, §4)** — smallest; pure query-param + ordering + deprecation
   headers. Quick win, unblocks the new sort UIs.
2. **Live conversation list (§5)** — REST list/preview/unread first, then the socket fan-out
   (esp. `message:created` to user rooms). Highest user-visible impact for existing chat.
3. **Events (§2)** — the largest schema addition; self-contained new domain.
4. **Push notifications (§1)** — the send infrastructure (FCM/APNs/Web Push + credential storage) is
   the heaviest lift and can land last; pairs with the notification taxonomy work in §6.
