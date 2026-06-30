# Proposed server changes

Forward-looking proposals that surfaced while building the **`agora-demo`** compatibility harness.
Each item is something the demo currently **works around client-side**, or a latent gap worth
closing. None are implemented yet — this is a design backlog.

Every item is tagged by its contract impact, because that's the constraint that governs Agora:

- 🟢 **Compat** — conforms the server to what the *stock* (unmodified) Replyke SDK already expects.
  Closing it is a bug fix, documented in `docs/MANIFEST.md` / `docs/MODELS.md`; no SDK fork.
- 🟡 **Additive divergence** — adds a field/behavior *beyond* the stock contract. The stock SDK
  ignores it; our demo (or a future client) reads it. Needs a `docs/MODELS.md` note. No SDK fork,
  but it's a real divergence from upstream.
- 🔴 **Hard divergence** — requires forking the SDK's typed contract (e.g. socket events). Adds a
  `SYNCING.md` merge-conflict surface. Highest cost; weigh against upstream-merge story.

> Already shipped this cycle (for reference, **not** proposals): chat list cursor shapes
> (`{conversations|messages, hasMore}`), `localId` echo on messages, `request-new-access-token`
> returns the user, connection routes reject non-UUID params with 400, and `ensureProfile` derives a
> default username on account creation. See `CHANGELOG.md`.
>
> **Live-inbox cycle (2026-06-30, merged to `root`):** §2, §3, and §5 below are now **✅ SHIPPED**, and
> §1 is **partially shipped** — see the per-section status banners. The realtime work landed *cheaper*
> than these proposals estimated: the per-user socket room + `emitToUser` + `notification:created`
> already existed, so §2/§5 needed no new SDK-contract divergence beyond the one net-new
> `conversation:created` event. See `CHANGELOG.md` + `docs/superpowers/specs/2026-06-29-live-inbox-unified-design.md`.

---

## 1. Include the direct-conversation partner in conversation payloads

> **Status: 🟡 PARTIALLY SHIPPED (2026-06-30).** The live-inbox work added `otherMembers[]`
> (≤5 active non-self members) to the `ConversationPreview` returned by `GET /chat/conversations`
> (list) and `GET /chat/conversations/:id/preview` — so the demo's per-row member fetch on the LIST
> is eliminated (a direct chat's `otherMembers` is exactly the one partner). **Not done:** attaching it
> to the base `GET /chat/conversations/:id` detail handler (deliberate non-goal — clients cache from the
> list), and any server-derived display `name` for DMs. Remaining work is detail-only.

**Tag:** 🟡 Additive divergence · **Priority:** High · **Effort:** Small

**Problem.** A `direct` conversation has `name: null`, and `shapeConversation`
(`server/src/lib/shape.ts`) only attaches `currentMember` (the requesting user) — never the *other*
participant. So a client can't name a 1:1 chat without a second round-trip, and the *receiver* of a
DM has nothing to label it with. (Stock Replyke's `Conversation` model has no `members[]`/`otherUser`
field either, so this is a genuine gap, not just an Agora omission.)

**Demo workaround.** `agora-demo/src/Chat.tsx` does an extra `GET /chat/conversations/:id/members`
per direct conversation (`<DirectLabel>` via `useConversationMembers`) to find the non-self member,
and titles the open thread from `useConversationContext().members`. That's an N+1 fetch on the
conversation list purely to render names.

**Proposed change.** In the `GET /chat/conversations` (and `GET /chat/conversations/:id`) handlers,
for `type === "direct"` attach the other participant — e.g. an `otherMember` (shaped `User`) or a
small `members[]`. Optionally derive a display `name` server-side for DMs. Eliminates the per-row
member fetch entirely.

**Files.** `server/src/routes/chat.ts` (conversation list/detail handlers), `server/src/lib/shape.ts`
(`shapeConversation` opts), `docs/MODELS.md` (document the new field as Agora-specific).

**Contract note.** Adds a field beyond the stock `Conversation` model → divergence, but additive and
low-risk (the stock SDK simply ignores unknown fields). The alternative is to leave the N+1 in
clients, which is what stock Replyke effectively forces.

---

## 2. Realtime connections + notifications (per-user socket channel)

> **Status: ✅ SHIPPED (2026-06-30) — at far lower cost than estimated.** The per-user room
> (`user:<projectId>:<userId>`, auto-joined on connect), `emitToUser()`, and the `notification:created`
> event already existed; the only real gap was that `routes/connections.ts` had a *local* `notify()`
> doing a raw `appNotifications` insert that bypassed `lib/notifications.ts`. Fixed by routing
> connection request/accept through `notifyOnConnectionRequest`/`notifyOnConnectionAccept` →
> the shared `insert()` → `notification:created` + push webhook. **No dedicated `connection:*` events
> and NO SDK fork** — they ride the existing `notification:created` (types `connection-request` /
> `connection-accepted`), so the "🔴 Hard divergence / Large" estimate was stale. The Inbox tab can now
> drop its 6s connections poll.

**Tag:** 🔴 Hard divergence · **Priority:** Medium · **Effort:** Large

**Problem.** Only chat is realtime. When someone accepts your connection request (or any
`appNotifications` row is written), the affected user gets no push — the socket layer
(`server/src/realtime/socket.ts`) only has per-*conversation* rooms and chat-scoped events. The
stock SDK socket contract (`@agora-sdk` `types/socket.ts`) is likewise chat-only.

**Demo workaround.** `agora-demo/src/Connections.tsx` polls `GET /connections` +
`GET /connections/pending/received` every 6s while the tab is open.

**Proposed change.** The socket already sets `socket.data.userId` on auth. Add:
- a per-user room join (`user:<userId>`) on connect, and an `emitToUser(userId, event, …)` helper;
- emit `connection:request` / `connection:accepted` / `connection:declined` from the handlers in
  `server/src/routes/connections.ts` (they already call `notify(...)`), and `notification:created`
  wherever `appNotifications` rows are inserted.

This also lets the **Inbox** go live and removes the connections poll.

**Files.** `server/src/realtime/socket.ts` (per-user room + `emitToUser` + event types),
`server/src/routes/connections.ts`, notification insert sites; **and** the forked SDK
(`@agora-sdk` `types/socket.ts` + a subscription in `chat-context`/a new context) → a **4th
`SYNCING.md` divergence** + rebuild.

**Contract note.** Net-new socket events Replyke deliberately doesn't have → hard divergence. Only
pursue if realtime social (beyond chat) is a product goal; otherwise polling is the cheaper,
fidelity-preserving choice.

---

## 3. Support an `after` cursor on `GET /chat/conversations/:id/messages`

> **Status: ✅ SHIPPED (2026-06-30).** The messages handler now accepts `?after=<ISO>` — filters
> `created_at > after` (ascending) for reconnect catch-up, validated up front (`400 chat/invalid-after`
> on a malformed timestamp, never a Postgres 500). Implementation note: the comparison truncates the
> column to milliseconds (`date_trunc('milliseconds', created_at)`) because the API serializes
> timestamps at ms precision (`toISOString()`) while Postgres stores µs — without it the cursor message
> re-appeared on every reconnect. (The SDK-side double-`/v7` URL bug in `catchUpMessages` is still an
> SDK-fork fix, out of scope for the server.)

**Tag:** 🟢 Compat · **Priority:** Medium · **Effort:** Small

**Problem.** The messages handler supports `before` (back-pagination), `sort`, and `parentId`, but
**not `after`**. The stock SDK's reconnect catch-up (`conversation-context.tsx` →
`catchUpMessages`) fetches `…/messages?after=<ISO>&sort=asc&limit=100` to backfill messages missed
while the socket was down. Against Agora that request can't return the right window.

**Demo workaround.** None — it's a silent gap; catch-up just doesn't work on reconnect (rarely hit
in normal use, so it hasn't bitten the demo yet).

**Proposed change.** Accept an `after` query param (ISO timestamp) and, when present, filter
`createdAt > after` (mirroring the existing `before` branch).

**Files.** `server/src/routes/chat.ts` (messages handler), `docs/MANIFEST.md`.

**Contract note.** The stock SDK already *sends* `after` → supporting it is conformance, not
divergence. (Separately, that stock SDK call also builds a malformed double-`/v7` URL
— `/${projectId}/v7/chat/...` — which is an **SDK-side** bug to fix in the fork, out of scope for
the server. Both must land for reconnect catch-up to actually work.)

---

## 4. Backfill default usernames for pre-existing profiles

**Tag:** 🟢 Compat (data) · **Priority:** Low · **Effort:** Tiny

**Problem.** `ensureProfile` now derives a default username for **new** accounts, but profiles
created before that change still have `username = NULL`, so clients fall back to a raw id slice
(e.g. `@86d127b3`). `ensureProfile` early-returns for existing profiles and never backfills.

**Demo workaround.** Users can self-set a name via the demo's new **Me** tab; otherwise nameless.

**Proposed change.** A one-time idempotent script (`server/scripts/backfill-usernames.mjs`) that
walks `profiles WHERE username IS NULL` and applies the same email-derived, uniqueness-safe logic as
`defaultUsername()`. Optionally factor `defaultUsername()` into a shared lib so the route and the
script share one implementation.

**Files.** new `server/scripts/backfill-usernames.mjs`, optional refactor of
`server/src/routes/auth.ts`.

---

## 5. Push a new conversation to its members in realtime (`conversation:created`)

> **Status: ✅ SHIPPED (2026-06-30) — server side.** `conversation:created` is emitted to each new
> member's `user:<projectId>:<userId>` room on `POST /chat/conversations` (group) and
> `POST /chat/conversations/direct` (genuine create only — the get-or-create early-return does NOT
> re-emit). Payload is the **rich** option: a zero-state `ConversationPreview` per recipient
> (`unreadCount: 0`, `lastMessage: null`, `otherMembers` excluding that recipient), so the client upserts
> with no follow-up GET. Also: `POST /chat/conversations/:id/messages` now fans `message:created` to the
> union of the conversation room AND every active member's user room, so inbox observers reorder/bump
> unread without joining the thread (the actual inbox-live driver). **Client/SDK follow-up still open:**
> the `@agora-sdk` `chat-context.tsx` listener for `conversation:created` + the `types/socket.ts` entry
> (this repo's `realtime/socket.ts` carries the event type already).

**Tag:** 🔴 Hard divergence · **Priority:** Medium · **Effort:** Medium · **Depends on:** §2 (per-user room)

**Problem.** When user A starts a chat with user B — `POST /chat/conversations/direct` (DM),
`POST /chat/conversations` (group), or `POST /chat/conversations/:id/members` (add to existing) — B
gets **no realtime signal**. The first two routes emit nothing at all; the member-add route emits
`member:joined` via `emitToConversation(...)`, i.e. only to the *conversation room*, which B has not
joined (rooms are joined on demand via `join:conversation` when a thread is opened). There is no
per-user channel in the chat realtime layer, so B's conversation list stays stale until a manual
refresh / remount. A's new chat simply doesn't appear on B's screen.

This is the **plaintext-chat analog of a fix we already shipped for secure chat**: the secure DS
emits `secure:welcome` to the recipient's (auto-joined) device room on conversation create, and the
secure SDK hook (`useSecureConversations`) listens for it and refreshes the list — so a new secure DM
appears on the peer's screen instantly. Plaintext chat has no equivalent server emit, so the same
client-side listener has nothing to hear; closing the gap **requires a server change**.

**Demo workaround.** None today (the symptom that prompted this). The only client-side option is to
poll `refresh()` on an interval in `agora-demo/src/Chat.tsx` (the pattern `Connections.tsx` /
`Follows.tsx` already use) — fidelity-preserving but not realtime, and it adds list-refetch load.

**Proposed change.** Reusing §2's per-user room (`user:<userId>`) + `emitToUser(userId, event, …)`:
add a net-new server→client event `conversation:created` and emit it to **each member added at
creation time** (excluding the actor, who already has the conversation from the REST response):

- `POST /chat/conversations/direct` — emit to the other participant. **Only on genuine create** —
  the route is get-or-create and returns early when the DM already exists; don't re-emit then.
- `POST /chat/conversations` — emit to every `memberIds` entry except the creator.
- `POST /chat/conversations/:id/members` — emit to the newly added `body.userId` (this *replaces*
  the effective gap, since today's `member:joined` never reaches the new member).

**Payload (recommended): the shaped conversation, per recipient** — exactly the shape a list item
has, so the client upserts it directly with no follow-up GET. The server already has everything: for
a brand-new conversation the per-recipient fields are trivial — `unreadCount: 0`, `lastMessage: null`,
`currentMember` = the member row just inserted for that user. i.e. emit
`shapeConversation(convo, { unreadCount: 0, lastMessage: null, currentMember: <their member row>, memberCount })`.
Because the emit is per-user-room, the recipient is known, so `currentMember` is correct per target.

> **Lightweight alternative:** emit `{ conversationId }` and let the client call its list `refresh()`
> (this is exactly what the secure-chat fix does with `secure:welcome`). Simpler server, but one
> extra `GET /chat/conversations` per recipient and a brief stale window. Prefer the rich payload to
> avoid the refetch and the prepend race; fall back to this if shaping-per-recipient is unwanted.

**Client/SDK side (our follow-up, not the server's work).** In the forked `@agora-sdk`,
`chat-context.tsx` already owns the socket and maintains the conversation-list slice (it handles
`message:created`, `conversation:updated`, …). Add one handler: `socket.on("conversation:created", …)`
→ `dispatch(upsertConversationPreview(...))` (rich payload) or trigger a list refresh (lightweight).
Then `agora-demo/src/Chat.tsx` needs **zero changes** — `useConversations` reads the slice. Also add
the event to `@agora-sdk` `types/socket.ts`. (Mirrors where the secure fix lived:
`useSecureConversations`, not the demo.)

**Files.** `server/src/realtime/socket.ts` (the `conversation:created` event type; per-user room +
`emitToUser` come from §2), `server/src/routes/chat.ts` (the three emit sites above),
`docs/MANIFEST.md` / `docs/MODELS.md`; **and** the forked SDK (`@agora-sdk` `types/socket.ts` +
`chat-context.tsx` listener) → shares §2's `SYNCING.md` divergence + rebuild.

**Contract note.** Net-new socket event the stock Replyke SDK doesn't have → hard divergence, same
class as §2. **Do this together with §2**: both ride the identical per-user-room primitive and the
same SDK fork touch-point, so landing them as one unit amortizes the divergence cost (one
`SYNCING.md` entry, one rebuild) instead of paying it twice. If §2 is deferred, this item carries the
per-user-room introduction itself.

---

## Considered, but not recommended

- **Accept a username in the connection-request endpoint.** The demo resolves `@username → id`
  client-side (`useFetchUserByUsername`) before calling `POST /users/:userId/connection`. Making the
  server accept a username in the `:userId` path slot would muddy a UUID-typed path param and
  diverge from the SDK contract (requests are keyed by id). Keep resolution in the client.

## Out of scope for the server (SDK-side follow-ups)

These were observed in the demo but belong to the forked `@agora-sdk`, not the server:

- **Optimistic chat message stores `createdAt` as a `Date`** (not an ISO string) in
  `useSendMessage`, tripping Redux Toolkit's serializability check. One-line fix
  (`now.toISOString()`); needs an SDK rebuild.
- **`catchUpMessages` double-`/v7` URL** (see §3 contract note).
