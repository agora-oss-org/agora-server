# Spec: server endpoints for the `@agora-sdk` v7.8.2 sync

**Owner:** agora-sdk (contract) → **Implementer:** agora-server team
**Status:** SDK side shipped (merged upstream Replyke/Sublay v7.8.2 into `agora`); server side TODO
**Repos:** SDK `../agora-sdk` (`@agora-sdk/*`, the forked Replyke SDK) · server `.` (`../agora-server`)
**Date:** 2026-07-07

---

## 0. TL;DR

The SDK sync to upstream v7.8.2 added seven client features (PRs #38–#44). Each hits the API. This
doc is the **client-side contract** — the exact routes, request shapes, and response shapes the SDK
now calls — plus **what the Agora server currently has** and **what it must implement**.

Everything here is **additive and backward-compatible**: a new SDK talking to a server that hasn't
implemented a feature degrades gracefully (the hook errors or returns empty; nothing else breaks).
So these can land **incrementally, in priority order** — nothing forces a coordinated deploy.

| # | Feature | Route | Server today | Effort |
|---|---|---|---|---|
| 1 | Notification preferences | `GET`/`PUT /:pid/push-notifications/preferences` | `/devices` + VAPID only; **no preferences** | S |
| 2 | Conversation mute | `POST /:pid/chat/conversations/:id/mute` | `conversation_members.muted_until` column exists; **no route, no `muted_forever`** | S–M |
| 3 | Space visibility | `visibility` on create/update + in responses | space schema has **no `visibility`** (only events do) | S |
| 4 | Follows/connections search | `?query=&searchFields=` on the list endpoints | list endpoints exist; **no `searchFields` narrowing** | S |
| 5 | User matching | `POST /:pid/match/users` | **no `/match/*` route** (`/search/users` is a different, simpler thing) | **L** |
| 6 | Space-reputation enrichment | `?spaceReputationId=&spaceReputationDescendants=` on many GETs | only a **global** `profiles.reputation` integer; **no space-scoped reputation, no param** | **L** |
| 7 | Search `includeChildSpaces` | `includeChildSpaces` in `/search/content` & `/search/ask` bodies | `spaceId` honored; **`includeChildSpaces` ignored** (single-space only) | S |

**Recommended order:** 1 → 3 → 4 → 2 → 7 (all small/mechanical), then 6 and 5 (large features that
can be deferred/stubbed — the SDK tolerates their absence).

All base paths are under `/v7/:projectId` (the SDK's `getApiBaseUrl()` default is
`http://localhost:4000/v7`). `:pid` = `:projectId` below.

---

## 1. Notification preferences  — PR #44  ·  effort S

### Why
End users want per-type control over which push notifications they receive (mute "someone upvoted"
but keep "someone replied"). The SDK exposes `useNotificationPreferences` (read + upsert) storing the
set of push event types the user has **opted OUT of**.

### SDK contract
Two routes; both request/return the **same body shape**:

| Route | Method | Body | Returns |
|---|---|---|---|
| `/:pid/push-notifications/preferences` | `GET` | — | `{ "disabledTypes": PushEventType[] }` |
| `/:pid/push-notifications/preferences` | `PUT` | `{ "disabledTypes": PushEventType[] }` | `{ "disabledTypes": PushEventType[] }` (echo the persisted set) |

- **Auth:** required (acting user). No preference row yet → `GET` returns `{ "disabledTypes": [] }`
  (all-on), **not** 404.
- **`PUT` is an upsert / full replace** of the set (not a delta). Echo back the stored set.
- **`disabledTypes`** — array of `PushEventType`. The **authoritative, exact** value set (same names,
  same order the SDK mirrors) — reject anything not in this list with `400`:

  ```
  entity-comment, comment-reply, entity-mention, comment-mention,
  entity-upvote, comment-upvote, entity-reaction, comment-reaction,
  entity-reaction-milestone-specific, entity-reaction-milestone-total,
  comment-reaction-milestone-specific, comment-reaction-milestone-total,
  new-follow, connection-request, connection-accepted,
  space-membership-approved, event-invite, event-updated, event-cancelled,
  message
  ```

  SDK source of truth: `packages/core/src/interfaces/PushEventType.ts` (`PUSH_EVENT_TYPES`). The SDK
  comment says these mirror the server's `src/constants/push/pushEvents.ts` — Agora should define the
  **same 20-value constant** and validate against it.

### Server today
`apps/api/src/routes/push-notifications.ts` has `POST`/`DELETE /devices` and the VAPID key route
only. **No preferences storage or route.**

### Implement
1. Storage — either a `push_notification_preferences` table `(project_id, user_id, disabled_types
   text[])` unique on `(project_id, user_id)`, or a `jsonb` column on `profiles`. A dedicated table
   is cleaner given the tenant scoping already used elsewhere.
2. Add the constant `PUSH_EVENT_TYPES` (+ a zod enum in `packages/contract`) and a
   `updateNotificationPreferencesSchema = z.object({ disabledTypes: z.array(pushEventType) })`.
3. `GET` (read, default empty) + `PUT` (upsert) under `pushNotificationRoutes`, `requireAuth`.
4. **Enforcement (the point of it):** when the push sender is about to deliver an event of type `T`
   to user `U`, skip if `T ∈ U.disabledTypes`. `message` (chat push) is included in the set so a user
   can disable chat push wholesale; per-conversation muting is feature #2.

### Compat
Old server + new SDK → `useNotificationPreferences` errors on the GET (surfaced via `error`), UI can
treat as "all-on". Non-blocking for the rest of the app.

---

## 2. Conversation mute  — PR #44  ·  effort S–M

### Why
Per-conversation "mute for 8h / 24h / 1w / forever" — suppress chat push for one conversation without
disabling chat push globally.

### SDK contract

| Route | Method | Body | Returns |
|---|---|---|---|
| `/:pid/chat/conversations/:conversationId/mute` | `POST` | `{ "duration": MuteDuration \| null }` | `{ "currentMember": ConversationMember }` |

- **Auth:** required. Acting user must be a member of the conversation.
- **`duration`** — one of `"8h"`, `"24h"`, `"1w"`, `"forever"`, **or `null` to clear** the mute. The
  client sends the **choice, never a timestamp**. SDK source: `interfaces/MuteDuration.ts`
  (`MUTE_DURATIONS`) — SDK comment references server `src/helpers/push/muteDuration.ts`.
- **Server resolves** the choice to a concrete `muted_until` (`now + Δ`), **except `"forever"`**,
  which is stored as a sentinel and surfaced via an explicit boolean — the SDK **never** string-matches
  a magic far-future date.
- **Response** = the acting user's own **self-serialized** `ConversationMember` row, including the mute
  fields (below). Return only the caller's row (not the whole member list).

### `ConversationMember` mute fields (SDK: `interfaces/models/ConversationMember.ts`)
```jsonc
{
  // …existing member fields…
  "mutedUntil":  "2026-07-08T12:00:00.000Z" | null, // real ISO ts for a timed mute; null when forever OR not muted
  "mutedForever": true | false                       // explicit "forever" signal
}
```
Semantics the SDK relies on:
- timed mute → `mutedUntil` = ISO timestamp, `mutedForever` = `false`
- forever    → `mutedUntil` = `null`, `mutedForever` = `true`
- not muted  → `mutedUntil` = `null`, `mutedForever` = `false`

**These two fields are present ONLY on the viewer's own row** (self-serialized) and omitted from other
members' rows. Don't leak one member's mute state to another.

### Server today
`conversation_members` already has `muted_until timestamptz` (`packages/core/src/db/schema/chat.ts`).
**Missing:** a `muted_forever boolean` (or an equivalent "forever" representation), the `POST …/mute`
route, and the self-serialization of these fields onto the member shape. No mute enforcement in the
push path yet.

### Implement
1. Migration: add `muted_forever boolean not null default false` to `conversation_members` (or model
   "forever" as `muted_until = NULL AND muted = true` — but a dedicated boolean is what the SDK shape
   expects, so prefer it).
2. `POST /:conversationId/mute`, `requireAuth`, member-check. Map duration → `{ muted_until,
   muted_forever }`; `null` clears both. Add `muteConversationSchema = z.object({ duration:
   muteDuration.nullable() })`.
3. Serialize `mutedUntil`/`mutedForever` onto the caller's own member row (this route's response, and
   ideally wherever the SDK reads the current member — e.g. conversation fetch/list for the viewer).
4. **Enforcement:** in the chat-push path, skip delivering `message` push to a user whose row for that
   conversation is muted (`muted_forever` OR `muted_until > now()`).

### Compat
Old server → `useMuteConversation` POST 404s; surfaced as a thrown error. Existing `muted_until` column
means part of the storage already exists.

---

## 3. Space visibility  — PR #43  ·  effort S

### Why
Spaces gain a `visibility` axis (`public` / `unlisted` / `private`) distinct from
reading/posting permission — controls discoverability (listing) separately from access.

### SDK contract
- **Create** `POST /:pid/spaces` body accepts optional `visibility: "public" | "unlisted" | "private"`.
- **Update** `PATCH /:pid/spaces/:id` body accepts optional `visibility` (same enum).
- **Responses** — `Space` and `SpacePreview` include `visibility`. Note the SDK types `Space.visibility`
  as a **required** field (`interfaces/models/Space.ts`), so the server should **always emit it**
  (default `"public"`), else strict consumers read `undefined`.

### Server today
`createSpaceSchema` / `updateSpaceSchema` (`packages/contract/src/schemas.ts`) accept
`readingPermission` / `postingPermission` / `requireJoinApproval` but **no `visibility`**. The spaces
table has no `visibility` column (only `events` do). `shapeSpace` doesn't emit it.

### Implement
1. Migration + `pgEnum("space_visibility", ["public","unlisted","private"])`; add
   `visibility space_visibility not null default 'public'` to the `spaces` table.
2. Add `visibility: spaceVisibility.optional()` to `createSpaceSchema` and `updateSpaceSchema`; thread
   `body.visibility` into the insert (create) and the `patch` object (update, guarded by `!== undefined`
   like the neighbors).
3. `shapeSpace` / `shapeSpacePreview` emit `visibility` (default `"public"` for legacy rows).
4. **Behavior:** `public` = listed/discoverable; `unlisted` = reachable by direct link/id but excluded
   from discovery listings; `private` = members-only (coordinate with the existing `readingPermission`
   gate). At minimum, emit + persist the field even if listing-filter semantics land later.

### Compat
Old server → create/update silently ignore `visibility` (zod strips unknowns) and responses omit it
(strict TS consumers see `undefined`). Emitting the field is the main compat win.

---

## 4. Follows / connections text search  — PR #42  ·  effort S

### Why
Search within a user's followers / following / connections lists by name or username.

### SDK contract
The list endpoints gain two optional **query params**:

| Endpoint (GET) | Params added |
|---|---|
| `/:pid/follows/followers` | `query`, `searchFields` |
| `/:pid/follows/following` | `query`, `searchFields` |
| `/:pid/connections` *(and `…/by-user-id` variants)* | `query`, `searchFields` |

- **`query`** — free-text term. Omitted → no filtering (current behavior).
- **`searchFields`** — `"username"` | `"name"`. Omitted → match **either** `username` OR `name`
  (case-insensitive substring). Present → restrict the match to that one field.
- Pagination (`page`, `limit`) unchanged. SDK source: `interfaces/UserSearch.ts` (`UserSearchParams`)
  + the `useFetchFollowers`/`useFetchFollowing`/`useFetchConnections(ByUserId)` hooks.

### Server today
The list endpoints exist and paginate; they do **not** accept `query`/`searchFields`. (The server
already does `ilike(username) OR ilike(name)` for the separate `/search/users` route, so the SQL
pattern is in hand.)

### Implement
Add `query` + `searchFields` to each list route: when `query` is present, add an `ilike` filter —
against `username` only, `name` only, or `OR` of both per `searchFields`. Reuse the existing `ilike`
helper from `search.ts`.

### Compat
Old server → params ignored, full list returned (client can filter locally as a fallback, but
server-side is the intent). Fully non-breaking.

---

## 5. User matching (`POST /match/users`)  — PR #41  ·  effort L (deferrable)

### Why
Activity/interest-based user matching — "find users like me" (passive) or "find users matching this
query" (directed), with per-facet similarity and optional sample content. This is an **AI/vector
feature**, materially larger than the rest of this doc.

### SDK contract

| Route | Method | Body | Returns |
|---|---|---|---|
| `/:pid/match/users` | `POST` | see below | `{ "results": UserMatchResult[] }` |

**Request body** (SDK: `hooks/search/useMatchUsers.ts`):
```jsonc
{
  "mode": "passive" | "directed",  // required. directed requires a non-empty query (SDK guards this client-side)
  "query": "string",               // optional (directed: the search text)
  "limit": 20,                     // optional
  "spaceId": "uuid",               // optional — scope to a space
  "includeChildSpaces": true,      // optional — extend spaceId to its subtree
  "includeSampleContent": true,    // optional — attach matched sample content per facet
  "excludeSelf": true              // optional — drop the acting user from results
}
```

**Response** — `{ "results": UserMatchResult[] }` where:
```jsonc
{
  "user":  User,        // full user object
  "score": 0.87,        // overall match score
  "matchedFacets": [
    {
      "similarity": 0.9,
      "askerFacet":     { "id": "…", "hotness": 0.5 },   // optional
      "candidateFacet": { "id": "…", "hotness": 0.7 },
      "sampleContent": [                                  // optional; only when includeSampleContent
        { "sourceType": "entity"|"comment"|"message", "recordId": "…", "content": "…", "similarity": 0.8 }
      ]
    }
  ]
}
```
Exact TS: `MatchFacetRef`, `SampleContent`, `MatchedFacet`, `UserMatchResult` in `useMatchUsers.ts`.

### Server today
No `/match/*` route. `/search/users` (in `search.ts`) is an unrelated simple `ilike` name search that
returns `{ similarity, record }[]` — **not** a substitute (different path, shape, and semantics).

### Implement / defer
Real implementation needs a per-user interest/activity facet model + vector similarity (the Agora
scorer/embedding stack — see `docs/SCORER.md`, `docs/SCORER-REQUIREMENTS.md`). **Recommended: defer**,
or ship a **stub** that returns `{ "results": [] }` (200) so the hook resolves cleanly to "no matches"
rather than erroring, until the matching engine lands. Track as its own feature.

### Compat
Old/stub server → `useMatchUsers` sets `error` (on 404) or returns empty (on stub). No other feature
depends on it.

---

## 6. Space-reputation enrichment param  — PR #39  ·  effort L (deferrable)

### Why
Attach a **space-scoped** reputation number to users embedded in responses (an entity's author, a
comment's author, chat members, search results, etc.), instead of only the tenant-global
`profiles.reputation`.

### SDK contract
A set of optional **query params** the SDK now threads onto **user-embedding GET endpoints** (entities,
comments, reactions, relationships, users, chat, spaces team/members, search, reports):

| Param | Type | Meaning |
|---|---|---|
| `spaceReputationId` | `<uuid>` \| `"none"` \| `"context"` | which space's reputation to attach. `"none"` = global; `"context"` = per-row's own space |
| `spaceReputationDescendants` | `boolean` | include reputation accrued in descendant spaces; only honored with an explicit `<uuid>` |

> The SDK's public API is now the **object** form `spaceReputation: { spaceId, includeDescendants? }`,
> but `buildSpaceReputationParams` (`utils/spaceReputationParams.ts`) always **flattens it to these two
> scalar query params on the wire** — so the server only ever sees `spaceReputationId` /
> `spaceReputationDescendants`. Implement to the scalars.

**Endpoint classes differ on the accepted value set** (SDK: `interfaces/SpaceReputation.ts`):
- **Context endpoints** (entities, comments, chat, spaces team/members, search, reports): accept
  `<uuid>` | `"none"` | `"context"`.
- **User-direct endpoints** (the `users` module: `/users/:id`, `/users/by-username`, `/users/:id/
  followers`, …): accept `<uuid>` | `"none"` only — **`"context"` must be rejected with `400`** here.

**Response:** when the param resolves, each embedded/returned user carries a `spaceReputation` value
(the SDK reads it off `UserFull.spaceReputation`). When the param is absent, embed nothing (today's
behavior) — the field is optional on the SDK `User` type.

### Server today
Only a **global** `profiles.reputation integer`. No space-scoped reputation model and no handling of
these params.

### Implement / defer
Needs a space-scoped reputation store (reputation per `(user, space)` with descendant rollup) plus
enrichment in every embedding controller. **Large.** **Recommended: defer**; because the params are
optional and the SDK object→scalar flattening omits them unless a caller opts in, **doing nothing is
safe** — embedded users simply won't carry `spaceReputation`. If/when partial support lands, start with
`"none"` (alias the existing global reputation) so the plumbing is exercised before the space-scoped
math.

### Compat
Fully non-breaking either direction — absent param → no enrichment; unknown param on an old server →
ignored.

---

## 7. Search `includeChildSpaces`  — PR #38  ·  effort S

### Why
When searching within a `spaceId`, optionally search the whole descendant subtree too.

### SDK contract
`includeChildSpaces?: boolean` added to the **POST bodies** of:
- `/:pid/search/content` (`useSearchContent`)
- `/:pid/search/ask` (`useAskContent`)

Ignored when no `spaceId` is supplied. (`useMatchUsers`, feature #5, carries the same flag.)

### Server today
`search.ts` has `/content`, `/ask`, `/spaces`, `/users`. The semantic-retrieval path (`AskBody` /
`retrieveContent` opts = `{ sourceTypes, spaceId, limit }`) honors a single `spaceId` but does **not**
read `includeChildSpaces` — a `spaceId` search is scoped to that one space only. Expand it to the
space's subtree when the flag is set.

### Implement
Accept `includeChildSpaces` in the two search schemas; when set **and** a `spaceId` is present, resolve
the space's descendant ids (there's already subtree logic behind `/spaces/:id/children` and the depth
model) and match against `spaceId ∈ {self ∪ descendants}`.

### Compat
Flag ignored by an old server → search stays scoped to the single space. Non-breaking.

---

## 8. Testing checklist (server)

- **Prefs:** GET default `{disabledTypes:[]}`; PUT replaces + echoes; unknown type → 400; enforcement
  skips a disabled type in the push path.
- **Mute:** each duration resolves `muted_until` correctly; `"forever"` → `mutedForever:true,
  mutedUntil:null`; `null` clears; response carries only the caller's row; non-member → 403/404; muted
  conversation suppresses `message` push.
- **Visibility:** create/update persist + echo; legacy rows default `"public"`; enum rejects garbage.
- **Follows/connections search:** `query` filters; `searchFields` narrows to one field; omitted → both;
  pagination still correct.
- **Match (if not stubbed):** `directed` w/o query → 400 or empty; `excludeSelf`; facet/sample shapes
  match the TS.
- **Space reputation (if implemented):** `"context"` → 400 on user-direct routes but OK on context
  routes; `spaceReputationDescendants` only honored with a `<uuid>`.

## 9. Out of scope

- SDK-side work — done (this is the merged upstream v7.8.2 surface; see agora-sdk `CHANGELOG.md`
  `[Unreleased]` and `SYNCING.md`).
- The AI/vector internals of user matching (#5) and the reputation math (#6) — those are their own
  designs (`docs/SCORER*.md`); this doc only pins the **wire contract** the SDK expects.
- Push transport itself (VAPID / APNs / FCM) — already shipped; #1/#2 only add
  preference/mute **filtering** on top.
