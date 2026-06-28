# Design — comment notifications: generation tweak + realtime delivery

**Date:** 2026-06-27
**Source spec:** `../agora-sdk/docs/server-comment-notifications-spec.md`
**Status:** Approved (brainstorming) — ready for implementation plan.

---

## Context

The SDK ships the entire client side of user↔user comment notifications (read path, typed
shapes, `useAppNotifications`). It asked the server for two things:

1. **Generation** — create `entity-comment` / `comment-reply` / `comment-mention` rows.
2. **Realtime delivery** — push `notification:created` over the existing socket.

**Finding on inspection:** generation is *already implemented* in
`apps/api/src/lib/notifications.ts` (`notifyOnComment`), wired at `routes/comments.ts:104`, with
metadata matching the spec 1:1 and suppression rules (self-notify skip, mention/reply dedup via a
`notified` Set). So this work is **mostly the realtime gap**, plus one generation policy change.

The socket server (`apps/api/src/realtime/socket.ts`) is currently 100% chat-scoped: rooms are
`conversation:<id>` only and the event union is all `message:*`/`typing:*`/`member:*`. There is no
per-user room and no notification event. There is no socket.io Redis adapter, so fan-out is
single-process per replica today (chat has the same limitation under `--profile scale`).

## Decisions (locked)

1. **Reply fan-out:** a reply notifies **both** the parent comment author (`comment-reply`) **and**
   the entity owner (`entity-comment`), deduped if they are the same user (one row, prefer
   `comment-reply`). (Diverges from current server behavior, which notifies parent only.)
2. **Unread count:** server emits **only** `notification:created`; the client owns the badge
   (increment locally / refetch `/count`). No `notification:unread_count` event.
3. **Cross-replica:** add the socket.io **Redis adapter now** (gated on `REDIS_URL`), which also
   fixes chat cross-replica fan-out.

---

## Components

### 1. Generation — reply notifies both (`lib/notifications.ts`)

In `notifyOnComment()`, the reply branch (`comment.parentId` truthy) currently emits only the
`comment-reply` to the parent author. Add an `entity-comment` to the entity owner in the same
branch, guarded by the existing `notified` Set so:

- parent author == entity owner → one row, the `comment-reply` (added to `notified` first).
- self (actor == owner/parent) → skipped by `insert()`'s existing `recipientId === actorId` guard.
- mentions still fan out as `comment-mention`, deduped against `notified`.

```
if (comment.parentId) {
  → comment-reply  to parent author    (existing; add parent author to `notified`)
  → entity-comment to entity owner     (NEW; skip if already in `notified`)
} else {
  → entity-comment to entity owner     (existing)
}
mentions → comment-mention             (existing, deduped)
```

Metadata shapes are unchanged (already match the spec). No other generation change.

### 2. Per-user room + `notification:created` event (`realtime/socket.ts`)

- Add `userRoom = (projectId, userId) => \`user:${projectId}:${userId}\`` —
  **project-namespaced** to prevent cross-tenant leakage.
- On `io.on("connection")`, after the existing auth middleware has set
  `socket.data.{userId,projectId}`, **auto-join** `socket.join(userRoom(projectId, userId))`.
  No client emit required; multiple tabs/devices all join the same room.
- Extend `ServerToClientEvents` with
  `"notification:created": (n: <shaped notification row>) => void`.
  Payload = the full shaped row (same shape REST returns), so the client prepends with no refetch.
- Add `emitToUser(projectId, userId, event, ...args)` mirroring `emitToConversation` (uses
  `ioRef?.to(userRoom(...)).emit(...)`).

### 3. Fan-out at the choke point (`lib/notifications.ts` `insert()`)

`insert()` already shapes the row for the webhook bridge. Add the socket emit beside it:

```
if (row) {
  const shaped = shapeNotification(row);
  webhooks.broadcast(projectId, "notification.created", shaped);    // existing
  emitToUser(projectId, recipientId, "notification:created", shaped); // NEW
}
```

`insert()` is the single choke point for **every** notification type, so this makes follows,
reactions, steward, space-approval — all of them — live, not just comments. Strictly more correct
(the SDK prepends whatever arrives) and DRY. No import cycle: `socket.ts` does not import
`notifications.ts`.

### 4. Cross-replica fan-out — Redis adapter (`realtime/socket.ts` + `apps/api` deps)

- New dependency: `@socket.io/redis-adapter` (compatible with socket.io 4.8 + ioredis).
- In `attachRealtime()`, gated and fail-soft like the rate-limit store:

```
const pub = getRedis();          // shared ioredis client; null when REDIS_URL unset
if (pub) {
  const sub = pub.duplicate();   // adapter needs a dedicated subscriber connection
  io.adapter(createAdapter(pub, sub));
  logger.info("socket: redis adapter enabled (cross-replica fan-out)");
}
// REDIS_URL unset → no adapter → single-process fan-out (current behavior, unchanged)
```

Reuses `getRedis()` for the pub side; only the `sub` connection is new (a subscriber socket can't
issue normal commands, so it must be separate). With the adapter live, every `emitToUser` **and**
existing `emitToConversation` crosses replicas.

Scope note: `apps/secure-chat` runs its own socket.io server — out of scope; it may adopt the same
pattern later via the kernel.

### 5. Testing

- **Generation** (extend `test/integration/notifications.test.ts`): a reply produces both a
  `comment-reply` to the parent author and an `entity-comment` to the entity owner; dedup when same
  user (one `comment-reply`); self-reply produces neither.
- **Realtime** (new test, mirror `test/integration/chat-realtime.test.ts`): connect a real
  `socket.io-client` as the recipient, have another user comment, assert `notification:created`
  arrives with the shaped row; assert the actor's own socket does **not** receive it.
- Gate: `pnpm -r typecheck` + `pnpm test` green. The Redis-adapter path is env-gated, so the
  no-Redis test path is unaffected.

---

## Out of scope (YAGNI)

- `notification:unread_count` event (client owns the badge).
- Comment collapsing / milestones ("5 people commented").
- Push (APNs/FCM) / email / digest — already bridged via webhooks.
- secure-chat adapter changes.

## Files touched

- `apps/api/src/lib/notifications.ts` — reply-both generation + `emitToUser` in `insert()`.
- `apps/api/src/realtime/socket.ts` — `userRoom`, auto-join, `notification:created` event,
  `emitToUser`, Redis adapter.
- `apps/api/package.json` — `@socket.io/redis-adapter`.
- `apps/api/test/integration/notifications.test.ts` — extended.
- `apps/api/test/integration/notifications-realtime.test.ts` — new.
- `CHANGELOG.md` — Added/Changed entries.
- SDK follow-up (separate repo): add the two socket events to the type union + notifications slice.
