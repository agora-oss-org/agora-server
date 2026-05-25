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

---

## 1. Include the direct-conversation partner in conversation payloads

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
