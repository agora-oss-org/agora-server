# Chat-message push fan-out — design

**Date:** 2026-07-09
**Feature:** SDK v7.8.2 follow-up #2 — activate chat-message push notifications, honoring the
per-conversation mute that already shipped but is currently unreachable.

## Goal

When a user sends a chat message, dispatch a background push notification (Web Push / FCM / APNs)
to every **other active member** of the conversation, suppressed by (a) the recipient's
per-conversation **mute** and (b) the recipient's **global chat-push opt-out** — both of which are
already built. Today the message-push code path is dead: it has no caller and its payload builder
returns `null` because `"message"` is missing from the push title map.

## Background — current state (verified by exploration)

The push machinery is already implemented and tested; only the wiring is missing:

- **`dispatchChatMessagePush(projectId, userId, conversationId): void`** (`apps/api/src/lib/push/index.ts:62`)
  — fire-and-forget, one recipient per call. It already: builds the payload, checks the global
  per-type opt-out (`loadDisabledTypes` / `isTypeDisabled`, feature #1), checks per-conversation mute
  (`isConversationMutedForUser`, feature #2), then dispatches to the user's devices. **Zero callers.**
- **`isConversationMutedForUser`** (`index.ts:51`) → pure predicate `isConversationMuted` (`lib/mute.ts:16`)
  over the recipient's own `conversation_members` row (`mutedUntil` / `mutedForever`). The mute **write**
  path (`POST /conversations/:id/mute`, `chat.ts:260`) already persists these columns.
- **`PUSH_TITLES`** (`apps/api/src/lib/push/dispatch.ts:49`) is the push-eligible allowlist AND title map.
  `"message"` is **absent**, so `notificationPushPayload("message")` returns `null` → every dispatch
  no-ops even if called. This is the second half of "unreachable."
- **`PUSH_EVENT_TYPES`** (`packages/contract/src/push.ts:36`) — the SDK-facing opt-out list — **already
  contains `"message"`**, so the global opt-out endpoint already accepts it. **No contract change.**
- **PII posture** (`dispatch.ts:41`, `SECURITY.md`): a push payload never carries another user's
  identity or content. `notificationPushPayload` hard-codes a generic body (`"Open the app to see
  what's new."`) and puts only `{ type }` in `data`. All three providers mirror this.

## Design decisions (approved)

1. **Row-less — no `app_notifications` row per message.** Chat already relies on socket delivery +
   unread counts, not the notification inbox. Writing a `type:"message"` inbox row would route through
   `insert()` → `dispatchNotificationPush`, which does **not** check per-conversation mute — that would
   *bypass the very mute feature this activates* and double-dispatch. So chat push stays on its
   dedicated `dispatchChatMessagePush` path, which honors mute.
2. **Suppression gates = mute + global opt-out only.** Ship exactly what the scaffold enforces. A
   suspended user can't post at all (posting-permission is checked pre-write), and no user-level block
   feature exists on the notify/push path today. A block/suspension-aware suppression check is a
   documented follow-up, not part of this change.
3. **Reuse the socket fan-out's member query.** The handler already selects all active member userIds
   for the socket emit; the push loop reuses that same list — no extra query.
4. **PII-free payload unchanged.** Reuse the existing generic title/body + `{ type: "message" }` data.
   The title for `"message"` is **"New message"**.

## The change (two edits + tests)

### Edit 1 — register the push type
`apps/api/src/lib/push/dispatch.ts`: add `"message": "New message"` to `PUSH_TITLES`. This alone makes
`notificationPushPayload("message")` return a payload instead of `null`.

### Edit 2 — call the fan-out on message create
`apps/api/src/routes/chat.ts`, in `POST /conversations/:id/messages`, immediately **after** the existing
`emitMessageCreated(...)` socket fan-out (~line 410), loop the already-fetched active `memberRows` and
dispatch to every member except the sender:

```ts
for (const m of memberRows) {
  if (m.userId !== c.var.auth!.userId) {
    dispatchChatMessagePush(c.var.projectId, m.userId, convo.id);
  }
}
```

`dispatchChatMessagePush` is `void` / fire-and-forget and swallows its own errors, so this cannot
affect the message-create response or latency. Nothing else changes: mute, opt-out, device lookup, and
VAPID/FCM/APNs gating are all downstream and already built. With no push provider configured, the whole
path is a silent no-op (unchanged behavior).

## Security considerations

- **No new PII surface.** Payload is the existing generic copy; sender identity / message content never
  leave the DB. `data` carries only `{ type: "message" }` for deep-linking.
- **Mute is enforced server-side** on the recipient's own row — the gate this feature exists to activate.
- **Self-suppression:** the sender is excluded from the loop (`m.userId !== sender`).
- **Fail-open on push is acceptable and intended:** a push failure never blocks message delivery; errors
  are logged at `debug` (raw) + `error` (message-only), per the logging policy.
- **No secrets/tokens logged** — reuses the existing device-dispatch code, which already redacts.

## Testing plan

- **Unit** (`apps/api/src/lib/push/*.test.ts`): assert `notificationPushPayload("message")` now returns
  `{ title: "New message", body: <generic>, data: { type: "message" } }` (was `null`). The mute predicate
  (`isConversationMuted`) and opt-out (`isTypeDisabled`) are already unit-tested.
- **Integration** (`apps/api/test/integration/`): send a message in a 2-member conversation and assert
  `dispatchChatMessagePush` is invoked for the other member and **not** the sender; assert it is
  suppressed when the recipient has muted the conversation (`mutedForever` and a future `mutedUntil`) and
  when the recipient has globally disabled `"message"`. Since real provider sends require VAPID/FCM/APNs
  creds (absent in the hermetic test env), assert at the **dispatch-decision** boundary (spy/observe that
  a device dispatch was attempted vs. skipped), not that a provider actually delivered.

## Out of scope / documented follow-ups

- **Block/suspension-aware push suppression** on the notify/push path (net-new; none exists today).
- **Chat @mention notifications** (messages store `mentions` jsonb but no chat-mention notify path exists).
- **"Active/foreground" suppression** (skip push if the recipient is currently viewing the conversation)
  — an optimization; the client dedupes today.
- The other v782 follow-ups (#3 space discoverability filtering, #5 real match engine) are separate work.

## Changelog / docs impact

- `CHANGELOG.md` `[Unreleased]` → **Added**: chat-message push notifications (honors per-conversation mute
  and the global chat-push opt-out).
- `MANIFEST.md`: note that `POST /conversations/:id/messages` now fans out push to other members
  (subject to mute + opt-out). No new endpoint, no new socket event, no contract/model change.
