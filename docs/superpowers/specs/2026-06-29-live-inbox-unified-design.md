# Spec C — Live Inbox + Realtime Connections (Unified)

**Date:** 2026-06-29
**Status:** Approved — ready for implementation plan
**Source docs:** `docs/superpowers/specs/2026-06-29-live-conversation-inbox-design.md` (Spec B), `docs/PROPOSED.md` §2 (realtime connections) + §3 (reconnect catch-up)
**Effort:** Small-medium. Mostly existing primitives (per-user room, emitToUser, notification:created) wired together; new socket helpers, preview shaper, one endpoint, one migration, reconnect cursor support.

---

## 1. Context & Current State

### 1.1 What works today

- **Chat inbox list** (`GET /chat/conversations`) — cursor-paginated on `coalesce(last_message_at, created_at) DESC`, returns `{ conversations, hasMore }`, already computes `unreadCount` + `lastMessage` per row.
- **Per-user socket room** (`user:{projectId}:{userId}`) — auto-joined on connect; used only for push notifications (`notification:created` event).
- **Notification infrastructure** — `lib/notifications.ts` handles all app-notification fan-out, emits via `emitToUser()` to the per-user room, and fires webhooks. Covers entity/comment mentions, reactions, follows, steward cases, space approvals.
- **Socket helpers** — `emitToConversation()` and `emitToUser()` available in REST handlers.
- **Connections route** — has its own local `notify()` function that does a raw `db.insert(appNotifications)` without wiring to realtime or webhooks.

### 1.2 Gaps vs. spec goals

1. **Chat inbox not live:** `message:created` is emitted only to the conversation room (active thread viewers); inbox observers (not in the thread room) never see it. Inbox list stays stale until manual refresh.
2. **No conversation preview shape:** no `shapeConversationPreview()`, so `otherMembers` is never populated and `lastMessage` is never truncated.
3. **No `/preview` endpoint:** single-conversation preview not available (though the list does compute the data).
4. **Connections are silent in realtime:** the local `notify()` in `connections.ts` bypasses the notification infrastructure, so connection requests/accepts never fire `notification:created` and don't push. Demo polls every 6 seconds.
5. **Reconnect catch-up broken:** SDK's reconnect backfill sends `?after=<ISO>` to `GET /messages`, but the handler doesn't support it — reconnect catches zero messages (silent gap, rarely hits in normal use).
6. **No keyset index:** list query doesn't use an optimal composite index for cursor pagination.

---

## 2. Goals

1. **Inbox goes live:** `message:created` reaches every member's user room; list reorders in realtime without refetch.
2. **New conversations appear instantly:** `conversation:created` event fires to each member's user room on group/direct create, excluding the creator (who gets it in REST response).
3. **Connections realtime:** connection request/accept/decline notifications fan out in realtime via the existing notification infrastructure (zero new socket events, no SDK fork).
4. **Reconnect works:** messages endpoint supports `?after=` cursor so SDK catch-up backfills correctly.
5. **Performance:** composite keyset index supports cursor pagination at scale.

### 2.1 Non-goals

- Attaching `otherMembers` to `GET /chat/conversations/:id` detail endpoint (stays unchanged; clients cache from the list).
- Dedicated socket events for connections (stay with `notification:created`; the type is `connection-request` / `connection-accepted` / etc., which the client filters).
- Changing the cursor envelope or thread-view events (already correct).

---

## 3. Design

### 3.1 Preview shapers (lib/shape.ts)

Three new pure helpers, unit-tested:

**`truncateMessageContent<T>(msg: T, max?: number): T`**
- Codepoint-safe truncation of `msg.content` (default max 100 chars).
- Leaves short content untouched (same reference for efficiency).
- Handles emoji and multibyte chars correctly (does not split surrogate pairs).
- Returns the input unchanged if `content` is not a string or null.

**`pickOtherMembers(rows: Array<{id, name, username, avatar}>, max?: number): Array<...>`**
- Caps to `max` (default 5) active, non-self members.
- Projects the four inbox fields (id, name, username, avatar).
- Called from the conversation-preview builder after filtering out `self`.

**`shapeConversationPreview(row, opts): ConversationPreview`**
- Extends `shapeConversation()` with:
  - `unreadCount: number` — messages after the member's `lastReadAt` (reuse existing computation).
  - `lastMessage: ChatMessage | null` — truncated to 100 chars via `truncateMessageContent()`.
  - `otherMembers: User[]` — ≤5 active non-self members; empty for space chats.
  - Optional `currentMember` — passed through.

Applied in: list endpoint, new `/preview` endpoint, and `conversation:created` emit payload.

### 3.2 Socket fan-out helpers (realtime/socket.ts)

**`messageCreatedRooms(conversationId, projectId, memberUserIds): string[]`**
- Returns `["conversation:{conversationId}", "user:{projectId}:{u1}", "user:{projectId}:{u2}", …]`.
- Unions the conversation room (active thread viewers) with every member's user room (inbox observers).
- Socket.io dedupes: a socket in both rooms gets exactly one delivery.

**`emitMessageCreated(conversationId, projectId, memberUserIds, message): void`**
- Emits `message:created` to all rooms returned by `messageCreatedRooms()`.
- No-op if socket server not attached (unit tests).

**ServerToClientEvents update:**
- Add `"conversation:created": (preview: unknown) => void;` after the `conversation:deleted` line.

### 3.3 Chat routes wiring (routes/chat.ts)

**New helper: `buildConversationPreview(c, convo, member)`** (module-private async)
- Fetches the latest message + unread count + ≤5 active non-self members (queries are scoped for efficiency).
- Returns `shapeConversationPreview(convo, { unreadCount, lastMessage, otherMembers, currentMember })`.
- Reused by list, preview endpoint, and conversation-create emit.

**New helper: `emitConversationCreated(c, convo, memberIds)`** (module-private async)
- For each member in `memberIds`, computes a zero-state preview (unreadCount: 0, lastMessage: null, otherMembers excluding that recipient).
- Emits `conversation:created` via `emitToUser()` to each member's user room.
- Skips space chats (for space chats, `conversation:created` is not emitted; members join via explicit space-subscribe).

**GET `/chat/conversations` (list)** — switch to preview shape
- Replace the current `shapeConversation()` calls with `buildConversationPreview()`.
- List now includes `unreadCount`, truncated `lastMessage`, and `otherMembers`.

**GET `/chat/conversations/:id/preview`** — new endpoint (inserted ABOVE `/:id` so Hono doesn't capture it)
- `requireAuth`, fetch the conversation, require membership, return `buildConversationPreview(c, convo, member)`.
- Returns 404 if not a member (via `requireMember()`).

**POST `/chat/conversations/:id/messages`** — message-create fan-out
- After shape + insert, fetch all member IDs: `db.select({ userId }).from(conversationMembers).where(and(eq(conversationId, convo.id), eq(isActive, true)))`.
- Call `emitMessageCreated(convo.id, c.var.projectId, memberIds, shaped)` instead of `emitToConversation()`.

**POST `/chat/conversations` (group create)**
- After insert + log line, call `await emitConversationCreated(c, convo!, memberIds)` before the REST response.

**POST `/chat/conversations/direct`** — direct/get-or-create
- **Only on genuine create:** if the conversation already exists (get-or-create returns early), do NOT emit.
- On genuine create (new conversation inserted), call `await emitConversationCreated(c, convo!, [creatorId, otherUserId])` before the REST response.

**GET `/chat/conversations/:id/messages`** — add `?after=` cursor support
- Accept optional `after: string` query param (ISO timestamp).
- When present, filter `createdAt > after` (reverse of the existing `before` branch).
- Return in ascending order (`asc` instead of `desc` when `after` is set) so the client backfills chronologically.
- Validate `after` as a valid ISO string; reject with 400 if malformed.

### 3.4 Connections realtime wiring (routes/connections.ts + lib/notifications.ts)

**In lib/notifications.ts:**
- Export two new public async helpers:
  - `notifyOnConnectionRequest(projectId, recipientId, requesterId)` — calls `insert()` with type `connection-request`, metadata includes the requester's profile.
  - `notifyOnConnectionAccept(projectId, recipientId, accepterId)` — calls `insert()` with type `connection-accepted`.
  - (Both reuse the existing actor-loading + fire-and-forget + `emitToUser()` + webhook pattern.)

**In routes/connections.ts:**
- Remove the local `notify()` function.
- In `/users/:userId/connection` POST (new request), replace `notify(...)` with `await notifyOnConnectionRequest(projectId, target, self.id)`.
- In `/connections/:id/accept` PATCH, replace `notify(...)` with `await notifyOnConnectionAccept(projectId, row.requesterId, self.id)`.
- Connection decline: no notification (spec'd as silent in the social layer).

Result: connection notifications now go through the full `notification:created` + webhook pipeline, so users see them in realtime if sockets are open, and via push if subscribed.

### 3.5 Database: keyset index migration

**File:** `apps/api/drizzle/00xx_conversations_keyset_idx.sql` (next sequential number; `when` must exceed current journal max `1781934611650`)

```sql
-- Keyset pagination index for the chat inbox. Matches GET /chat/conversations:
--   ORDER BY COALESCE(last_message_at, created_at) DESC, keyset on the same boundary.
-- Idempotent.
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_keyset_idx"
  ON "conversations" ("project_id", (COALESCE("last_message_at", "created_at")) DESC, "created_at" DESC);
```

Update `_journal.json`: append entry with `idx: 53`, `when: 1781934611651`, `tag: "0053_conversations_keyset_idx"`.

### 3.6 Reconnect & room rejoin

**Decision:** Server stays stateless about conversation rooms. On reconnect, the client re-emits `join:conversation` for the open thread; the user room is auto-joined on connect, so the **inbox keeps working with no client action**. No server-side session storage.

---

## 4. Data Flow

### 4.1 Message in a conversation (live inbox update)

```
User A sends a message to conversation [A, B, C]:
  1. Message inserted in chatMessages, shaped
  2. emitMessageCreated(convId, projectId, [A, B, C], shaped) called
  3. Socket emits message:created to rooms:
     - conversation:{convId}       (A, B, C in thread room get it)
     - user:{proj}:A
     - user:{proj}:B
     - user:{proj}:C               (all members' inboxes get it)
  4. B's socket (if open, any tab/device):
     - If inbox tab is open: chat-context listener re-fetches OR reorders list in-place
     - If thread tab is open: thread-view handler updates the message list
     - If both: dedup handled by socket.io room membership
  5. C's socket (similarly): sees message:created, updates inbox/thread
```

### 4.2 New conversation (appears on recipient's inbox)

```
User A creates a direct chat with User B:
  1. Conversation + member rows inserted for both A and B
  2. A gets conversation in REST response (201)
  3. emitConversationCreated(c, convo, [A, B]) called:
     - For recipient B: computes otherMembers = [A], unreadCount = 0, lastMessage = null
     - Emits conversation:created to user:{proj}:B with the preview
  4. B's socket receives conversation:created (on user room listener):
     - chat-context upserts it into the conversation list
  5. B sees new conversation appear instantly (before opening app)
  6. If A re-creates with B (get-or-create returns early), no re-emit
```

### 4.3 Connection request (realtime + push)

```
User A requests connection with User B:
  1. Connection row inserted, status = pending
  2. notifyOnConnectionRequest(proj, B, A) called:
     - inserts appNotifications row with type = connection-request
     - emitToUser(proj, B, "notification:created", shaped) fires
     - webhook broadcast(proj, "notification.created", shaped) fires
  3. B's socket (if open): receives notification:created in user:{proj}:B room
  4. B's push subscriber (if registered): receives webhook event
  5. B sees notification in real-time inbox (no poll)
```

---

## 5. Testing

### 5.1 Unit (vitest, no DB)

- `truncateMessageContent`: 100-char cap, emoji safety (surrogate pairs), short msg pass-through, null/non-string handling
- `pickOtherMembers`: 5-member cap, self exclusion, field projection
- `messageCreatedRooms`: returns correct room union (conversation + all member user rooms)

### 5.2 Integration (real Postgres, TEST_DATABASE_URL)

- Preview endpoint: shape is correct for direct/group/space; non-member gets 404
- List shape: includes unreadCount, truncated lastMessage, otherMembers; reorders when message:created fires
- Realtime inbox: member receives `message:created` on user room WITHOUT joining conversation room
- Conversation creation: `conversation:created` fires to each member's user room (excluding creator)
- Connections: `connection-request` notification fires to recipient's user room; `connection-accepted` fires to requester
- Reconnect cursor: `?after=<ISO>` returns messages in ascending order after that timestamp; validates ISO format (400 on garbage)
- Keyset index: list query uses the new index (verify EXPLAIN PLAN); re-applying migration is idempotent

---

## 6. Files Touched

- `apps/api/src/lib/shape.ts` — add `truncateMessageContent()`, `pickOtherMembers()`, `shapeConversationPreview()`
- `apps/api/src/realtime/socket.ts` — add `messageCreatedRooms()`, `emitMessageCreated()`; add `conversation:created` to `ServerToClientEvents`
- `apps/api/src/routes/chat.ts` — add `buildConversationPreview()`, `emitConversationCreated()` helpers; wire message fan-out; add `/preview` endpoint; switch list to preview shape; add `?after=` cursor support
- `apps/api/src/routes/connections.ts` — replace local `notify()` with calls to `lib/notifications` helpers
- `apps/api/src/lib/notifications.ts` — add `notifyOnConnectionRequest()`, `notifyOnConnectionAccept()` public helpers
- `apps/api/drizzle/00xx_conversations_keyset_idx.sql` — **new** migration
- `apps/api/drizzle/meta/_journal.json` — append migration entry
- `CHANGELOG.md` — document changes under `[Unreleased] / Added / Changed / Fixed`

---

## 7. Decisions (Resolved)

- **Room rejoin:** Client re-emits `join:conversation` on reconnect; server stateless.
- **`message:created` fan-out:** Goes to both conversation room AND member user rooms (inbox-driving).
- **Connection notifications:** Reuse `notification:created` (no new socket events); types are `connection-request`, `connection-accepted`, etc.
- **`otherMembers` scope:** List + `/preview` endpoints only; detail endpoint (`/:id`) unchanged.
- **Reconnect catch-up:** Support `?after=` cursor; `before` cursor unchanged (existing behavior).

---

## 8. Scope & Effort

- **Lines of code:** ~400 new (helpers, endpoint, wiring), ~50 changed (list routing, message fan-out, connections)
- **Tests:** ~15 unit assertions + ~8 integration tests
- **Migrations:** 1 (keyset index)
- **New socket events:** 1 type added (others are existing infrastructure)
- **SDK changes needed:** None (client-side listener for `conversation:created` is SDK work, not server)

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `emitMessageCreated` on every message creates per-member fan-out load | Fan-out is a single `io.to([rooms])` call to socket.io; no N HTTP requests. With Redis adapter, it crosses replicas efficiently. |
| List shape change breaks older clients | The contract is a list of conversations; adding fields is additive (stock SDK ignores unknown fields). No breaking change. |
| Connection notifications create duplicate entries (old local notify + new routed notify) | Old `notify()` function is deleted; only `notifyOnConnectionRequest()` path exists. |
| Reconnect `?after=` with bad ISO timestamp crashes | Validate with try-catch or zod; return 400 `invalid-after-timestamp` on parse fail. |

---

## 10. Self-Review Checklist

- ✅ No placeholder sections or TODOs
- ✅ Architecture matches feature descriptions (fan-out design, preview shaper, realtime wiring are all described in context)
- ✅ Scope is focused: inbox + connections realtime + reconnect cursor; no unrelated refactors
- ✅ All requirements from PROPOSED.md §2 (connections realtime) + §3 (reconnect) + Spec B (inbox live) covered
- ✅ Decision to exclude `otherMembers` on detail endpoint is explicit (§2.1 non-goals)
- ✅ Testing strategy is clear: unit shapers, integration on real DB
- ✅ All files listed; journal entry format matches existing entries
- ✅ Data flows are concrete (not hand-wavy)

