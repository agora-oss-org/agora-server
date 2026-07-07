# Spec: server endpoints for the `@agora-sdk` v7.6.2 sync

**Owner:** agora-sdk (contract) → **Implementer:** agora-server team
**Status:** ✅ **server side shipped & verified against source** — this is a *retrospective conformance
record*, not a TODO. Every feature below is already implemented (with contract tests); documented for
parity and as the versioned companion to `SDK-V7.8.2-SERVER-SPEC.md`.
**Repos:** SDK `../agora-sdk` (`@agora-sdk/*`, the forked Replyke SDK) · server `.` (`../agora-server`)
**Date:** 2026-07-07 (recorded retrospectively; features landed alongside the v7.6.2 sync, agora-sdk `v1.4.0`)

---

## 0. TL;DR

The **previous** SDK sync — upstream Replyke/Sublay **v7.6.2** (agora-sdk `v1.4.0`, merge `61f86be`) —
brought seven upstream PRs (#27–#37). This doc pins each **client-side contract** the SDK calls and
**confirms the agora server already implements it**. The server was built to this exact SDK version —
its source even cites the SDK types by name (e.g. `comment-sort.ts`: "SDK CommentsSortByOptions").

Contrast with `SDK-V7.8.2-SERVER-SPEC.md`, which is a forward-looking gap list. **Here everything is
green** — nothing to build; use this as the contract of record and a conformance checklist.

| # | Feature (SDK PR) | Route(s) | Server state | Evidence |
|---|---|---|---|---|
| 1 | **Events bundle** (#27) | `…/events` full CRUD + rsvp/invites/hosts | ✅ implemented | `apps/api/src/routes/events.ts`, `packages/contract/src/events.ts` |
| 2 | **Push device registration** (#29) | `POST`/`DELETE …/push-notifications/devices` | ✅ implemented | `apps/api/src/routes/push-notifications.ts` |
| 3 | **Entity `createdAt` sort** (#31) | `sortBy=createdAt` (+ `new` deprecated) | ✅ implemented | `apps/api/src/routes/entities.ts` (RFC 8594 deprecation) |
| 4 | **Comment `createdAt`/`sortDir`/`controversial` sort** (#32–#34) | `?sortBy=&sortDir=` on comment list | ✅ implemented | `apps/api/src/lib/comment-sort.ts` |
| 5 | **Live conversation list** (#37) | `GET …/chat/conversations/:id/preview` + `conversation:created` socket | ✅ implemented | `apps/api/src/routes/chat.ts` |
| 6 | **Spaces boolean-flag fix** (#30) | space-list query flags (client-side change) | ✅ compatible | client-only fix; server already strict |

All base paths under `/v7/:projectId` (`:pid` below).

---

## 1. Events bundle — PR #27 · ✅ implemented

### Why
Full events feature: create/list/fetch/update/delete events, RSVP, invites, and co-hosts, with inline
cover/gallery image upload on create & update.

### SDK contract (endpoints called by `@agora-sdk/core` `hooks/events/*`)

| Route | Method | Hook | Notes |
|---|---|---|---|
| `/:pid/events` | `POST` | `useCreateEvent` | JSON **or** `multipart/form-data` (inline cover/gallery upload) |
| `/:pid/events` | `GET` | `useFetchManyEvents` | paginated (`PaginatedResponse<Event>`) |
| `/:pid/events/:eventId` | `GET` | `useFetchEvent` | |
| `/:pid/events/:eventId` | `PATCH` | `useUpdateEvent` | JSON **or** multipart; body may carry **`removeImageIds`** |
| `/:pid/events/:eventId` | `DELETE` | `useDeleteEvent` | |
| `/:pid/events/:eventId/cancel` | `POST` | `useCancelEvent` | |
| `/:pid/events/:eventId/rsvp` | `POST` / `DELETE` | `useSetRsvp` / `useWithdrawRsvp` | |
| `/:pid/events/:eventId/rsvps` | `GET` | `useFetchEventRsvps` | paginated (`EventRsvp`) |
| `/:pid/events/:eventId/invites` | `POST` / `DELETE` / `GET` | `useAddInvite` / `useRemoveInvite` / `useFetchInvitees` | |
| `/:pid/events/:eventId/hosts` | `POST` / `DELETE` | `useAddHost` / `useRemoveHost` | |

### Server state — ✅
`apps/api/src/routes/events.ts` implements all of the above (`POST`/`GET /`, `GET`/`PATCH`/`DELETE
/:eventId`, `/cancel`, `/rsvp` POST+DELETE, `/rsvps` GET, `/invites` POST+DELETE+GET, `/hosts`
POST+DELETE). Create & update parse **multipart** (`c.req.parseBody({ all: true })`) and persist cover
(one) + gallery images; `updateEventSchema` (`packages/contract/src/events.ts`) includes
`removeImageIds: z.array(z.string().uuid()).optional()` — matching `useUpdateEvent` exactly. Contract
schemas: `createEventSchema` / `updateEventSchema`.

---

## 2. Push device registration — PR #29 · ✅ implemented

### Why
Register a device's push token/subscription so the server can deliver push. `usePushRegistration`
(core) + the platform token adapters (`webPushTokenAdapter`, RN Firebase, Expo) obtain the
token/subscription and register it.

### SDK contract
The SDK's `pushApi` (RTK Query) registers/deregisters the acting user's device:

| Route | Method | Purpose |
|---|---|---|
| `/:pid/push-notifications/devices` | `POST` | upsert device (web: `{subscription}`; native: `{platform, token}`) |
| `/:pid/push-notifications/devices` | `DELETE` | remove device |

### Server state — ✅
`apps/api/src/routes/push-notifications.ts`: `POST /devices` (atomic upsert — web dedupes on
`(project,user,endpoint)`, native on `(project,user,platform,token)`), `DELETE /devices`, plus a
`POST /devices/deregister` convenience and the VAPID public-key route. (Push **preferences** and
**mute** are the *v7.8.2* additions — see `SDK-V7.8.2-SERVER-SPEC.md` §1–2; those are the open items,
not this.)

---

## 3. Entity `createdAt` sort — PR #31 · ✅ implemented

### SDK contract
`EntityListSortByOptions` (SDK) = `"createdAt" | "top" | "hot" | "controversial" | "new"(deprecated) |
"metadata.*"`. `"new"` is a directional alias for `"createdAt"` DESC, kept for back-compat. Sent as the
`sortBy` query param on the entity-list fetch (`GET /:pid/entities`), with `sortDir`.

### Server state — ✅
`apps/api/src/routes/entities.ts` parses `sortBy` (hot/top/**createdAt**/new/controversial/`metadata.x`)
+ `sortDir`; when `sortBy` is absent it falls back to the project's `defaultAlgorithm`. The legacy
`new` alias is mapped to canonical `createdAt` and flagged deprecated via **RFC 8594** (`markDeprecated`
/ `isDeprecatedEntitySort`; `Deprecation` header, no `Sunset`). Matches the SDK's
`DeprecatedNewSortBy` handling.

---

## 4. Comment `createdAt` / `sortDir` / `controversial` sort — PRs #32–#34 · ✅ implemented

### SDK contract
`CommentsSortByOptions` (SDK) = `"createdAt" | "top" | "controversial" | "new"(dep) | "old"(dep)`, plus
`sortDir: "asc" | "desc"` (honored for `createdAt`; default `desc`). `"new"`/`"old"` are directional
aliases for `createdAt` DESC/ASC. Sent as `sortBy` + `sortDir` query params on `GET /:pid/comments`.

### Server state — ✅
`apps/api/src/lib/comment-sort.ts` — `resolveCommentSort(sortBy, sortDir)` maps:
- `createdAt` → `(createdAt, dir)`; `top` → upvotes; `controversial` → the shared controversy formula;
- `new` → `(createdAt, desc, deprecated)`, `old` → `(createdAt, asc, deprecated)`;
- unknown/absent → `createdAt desc` (canonical default).

`commentOrderBy` builds the Drizzle `ORDER BY` (with `comments.id` tiebreak). Deprecation surfaced per
RFC 8594. `contract-schemas.test.ts` exercises all five `sortBy` values + `sortDir`. Full parity with
`useFetchManyComments` / the comment-section hooks.

---

## 5. Live conversation list — PR #37 · ✅ implemented

### Why
The chat conversation list stays live: a single-preview fetch (to refresh/insert one row) plus socket
events so a new conversation appears without a full re-list. `ChatProvider` wires the live list;
`useFetchConversationPreview` fetches one preview.

### SDK contract
| Route / channel | Kind | Purpose |
|---|---|---|
| `/:pid/chat/conversations/:conversationId/preview` | `GET` | single conversation **preview** (unread count, last message, members summary) |
| `/:pid/chat/conversations` | `GET` | the paginated list (existing) |
| `conversation:created` | socket event | pushed to each recipient with a zero-state preview payload |

### Server state — ✅
`apps/api/src/routes/chat.ts`: `GET /conversations/:id/preview` (`requireAuth` + member check →
`buildConversationPreview`). On conversation creation the server emits `conversation:created` to each
member's inbox via `emitToUser` with a `shapeConversationPreview` payload (unreadCount 0, no
lastMessage) — exactly what the SDK's live-list reducers consume.

---

## 6. Spaces boolean-flag fix — PR #30 · ✅ compatible (client-side change)

### What
Upstream fix `fix/space-list-memberof-400`: the SDK now sends space-list boolean query flags (e.g.
`memberOf`) **only when strictly `true`**, instead of serializing `false`/`undefined` into the query —
which some validators rejected with `400`.

### Server state — ✅
This is a **client-behavior** change with no new server contract; the agora server's space-list query
validation already accepts the corrected requests. No server action was or is required — recorded here
only so the PR is accounted for.

---

## 7. Conformance checklist (server — all currently ✅)

- **Events:** create/update accept multipart + persist cover/gallery; `removeImageIds` honored on
  update; rsvp/invite/host sub-routes present; list paginates.
- **Push:** `/devices` upsert dedupes correctly per platform; delete works.
- **Entity sort:** `createdAt` canonical; `new` → deprecated alias w/ RFC 8594 header; `sortDir` honored.
- **Comment sort:** all five `sortBy` values; `sortDir` honored for `createdAt`; `new`/`old` deprecated;
  stable tiebreak.
- **Conversation preview:** `GET …/preview` returns the preview shape; `conversation:created` socket
  event fires to each member on creation.

## 8. Out of scope

- SDK-side work — shipped (this is the merged upstream v7.6.2 surface; agora-sdk `CHANGELOG.md`
  `[1.4.0]` and `SYNCING.md`).
- The **v7.8.2** additions (notification preferences, conversation mute, space visibility,
  follows/connections search, user matching, `spaceReputation`, search `includeChildSpaces`) — those
  are the open/forward-looking items; see **`SDK-V7.8.2-SERVER-SPEC.md`**.
- Push transport internals (VAPID/APNs/FCM) and the app-notification pipeline — pre-existing.
