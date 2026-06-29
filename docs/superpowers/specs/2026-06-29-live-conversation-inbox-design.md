# Spec B — Live Conversation Inbox (FEATURE_MIGRATION §5)

**Date:** 2026-06-29
**Status:** Approved — ready for implementation plan
**Source doc:** `docs/FEATURE_MIGRATION.md` §5 (Live conversation list)
**Effort:** Small-medium. One migration (index), one new endpoint, one new shaper, a socket fan-out
fix. **Most of this already exists** — the doc over-estimated server effort.

---

## 1. Context & current state

The SDK makes the chat inbox live: a cursor-paginated conversation list, socket-driven reorder/unread,
and reconnect reconciliation. Server reality (from `apps/api/src/routes/chat.ts`,
`apps/api/src/realtime/socket.ts`, `packages/core/src/db/schema/chat.ts`,
`apps/api/src/lib/shape.ts`):

**Already built:**
- `GET /chat/conversations` — cursor list on `coalesce(last_message_at, created_at) DESC`, returns
  `{ conversations, hasMore }`, params `limit`(≤20)/`types`/`cursor`/`cursorCreatedAt`; already
  computes `unreadCount` + `lastMessage` per row (`chat.ts:62-102`).
- `GET /chat/conversations/unread-count` → `{ totalUnread, unreadConversationCount }` across all
  active member conversations (`chat.ts:144-158`).
- Per-user room `user:{projectId}:{userId}`, **auto-joined on connect** (`socket.ts:52,149`);
  `emitToConversation()` and `emitToUser()` helpers (`socket.ts:177-196`).
- Schema: `conversations.last_message_at` (nullable), `conversation_members.last_read_at`,
  `is_active`; message recency index. Base shapers `shapeConversation`/`shapeChatMessage`.

**Gaps vs §5:**
1. **CRITICAL:** `message:created` is emitted **only** to the conversation room
   (`socket.ts` ~line 325). Inbox-only observers (not in the thread room) never see it. §5.4 requires
   fan-out to **both** the conversation room **and** every member's user room.
2. No `GET /chat/conversations/:id/preview` endpoint (§5.1).
3. No `shapeConversationPreview()` — `otherMembers` is never populated; `lastMessage` is not
   truncated to 100 chars.
4. No composite keyset index `(last_message_at DESC NULLS LAST, created_at DESC)` — current index is
   `(project_id, last_message_at DESC)`.
5. `conversation:created` payload completeness unconfirmed — must always carry `unreadCount`.

## 2. Goals

1. `message:created` reaches all members' user rooms (inbox) AND the conversation room (thread).
2. Add `GET /chat/conversations/:id/preview` returning one `ConversationPreview`.
3. `ConversationPreview` shape is consistent across the list endpoint, the preview endpoint, and the
   `conversation:created` socket payload: `unreadCount`, `lastMessage` (≤100 chars), `otherMembers`
   (≤5 active non-self; empty for space chats).
4. Composite keyset index for stable cursor pagination.

**Non-goals:** changing the cursor envelope (already correct), thread-view events (already present),
client-side reconnect logic (lives in the SDK).

## 3. Design

### 3.1 The critical fan-out fix (`realtime/socket.ts` + REST message-create handler)

When a message is created, after writing, fan out `message:created`:
- to `conversation:{conversationId}` (active thread viewers — current behavior), AND
- to `user:{projectId}:{memberUserId}` for **every** member of the conversation (inbox observers).

De-dupe is unnecessary (socket.io rooms handle a socket present in both). Provide a helper, e.g.
`emitMessageCreated(convo, shapedMessage, memberUserIds)`, so the logic lives in one place and is
unit-testable. The member-id list is already available where the message is written.

### 3.2 `shapeConversationPreview()` (`lib/shape.ts`)

Extends the base conversation shape with:
- `unreadCount: number` — messages after `currentMember.lastReadAt` (reuse existing computation).
- `lastMessage: ChatMessage | null` — **truncated to 100 chars** (truncate `content`; keep the rest
  of the shape). Truncation is a pure helper, unit-tested.
- `otherMembers?: Pick<User,"id"|"name"|"username"|"avatar">[]` — ≤5 **active, non-self** members,
  **direct/group only**; **empty for space chats** (`Conversation.ts:38`).

Apply it in: the list endpoint, the new preview endpoint, and the `conversation:created` emit path.

### 3.3 Preview endpoint (`routes/chat.ts`)

`GET /chat/conversations/:id/preview` → one `ConversationPreview`. **Route ordering:** declare it
(and `unread-count`) **above** `/:conversationId` so Hono doesn't capture them (Handler conventions).
Auth: requester must be an active member (existing membership gate); 404 via `removedPolicy`-style
hiding if not a member.

### 3.4 `conversation:created` payload

Always emit a full `ConversationPreview` (the client branches on `unreadCount` presence,
`chat-context.tsx:474`). For a brand-new conversation `unreadCount` is `0`, `otherMembers` populated.

### 3.5 Migration (composite index)

New custom migration `00xx_conversations_keyset_idx.sql` (idempotent):

```sql
CREATE INDEX IF NOT EXISTS conversations_keyset_idx
  ON conversations (project_id, coalesce(last_message_at, created_at) DESC NULLS LAST, created_at DESC);
```

(Confirm the exact expression matches the list query's ORDER BY so the planner uses it.)

### 3.6 Reconnect / room rejoin

**Decision:** the server stays **stateless** about conversation rooms. On reconnect the client
re-emits `join:conversation` for the open thread; the user room is auto-joined on connect, so the
**inbox keeps working with no client action**. No server-side room persistence.

## 4. Files touched

- `apps/api/src/realtime/socket.ts` — fan out `message:created` to user rooms; full
  `conversation:created` payload.
- `apps/api/src/routes/chat.ts` — message-create fan-out call; new `/preview` endpoint (ordered
  above `/:conversationId`).
- `apps/api/src/lib/shape.ts` — `shapeConversationPreview()` + truncation + `otherMembers`.
- `apps/api/drizzle/00xx_conversations_keyset_idx.sql` — **new** migration (next free number; `when`
  must exceed the journal max watermark).

## 5. Testing

- **Integration** (`test/integration/**`, real Postgres): preview endpoint returns the right shape
  for direct/group/space; `otherMembers` empty for space chats; non-member gets 404; list ordering
  stable under the new index; `message:created` reaches a member's user room without joining the
  thread room.
- **Unit:** `lastMessage` truncation (≤100 chars, multibyte-safe); `otherMembers` selection (≤5,
  active, non-self).

## 6. Decisions (resolved)

- **Room rejoin:** client re-emits `join:conversation`; server stateless.
- `message:created` **does** fan out to user rooms (the inbox-driving event).
- `conversation:created` always includes `unreadCount` (+ `otherMembers`, `lastMessage`).

## 7. Open questions

- Confirm the exact ORDER BY expression in `GET /chat/conversations` so the composite index matches
  it verbatim (verify during implementation against `chat.ts:62-102`).
- Whether the existing list endpoint already returns the preview shape or the base conversation — if
  base, switch it to `shapeConversationPreview()` (the report flagged this as unclear).
