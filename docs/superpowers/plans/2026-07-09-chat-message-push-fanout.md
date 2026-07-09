# Chat-message push fan-out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On chat-message send, dispatch a background push to every *other* active conversation member, suppressed by per-conversation mute and the global chat-push opt-out — activating the already-built-but-unreachable `dispatchChatMessagePush`.

**Architecture:** Two-line activation of existing machinery — register the `"message"` push title so the payload builder stops returning `null`, and call the fire-and-forget `dispatchChatMessagePush` per non-sender member right after the existing socket fan-out. Extract the async body into an awaitable `sendChatMessagePush` so the mute/opt-out decision is integration-testable at the `webpush.sendNotification` boundary (the pattern the existing `push-dispatch.test.ts` uses).

**Tech Stack:** Hono, Drizzle (postgres.js), vitest (unit + real-Postgres integration), web-push/FCM/APNs providers.

## Global Constraints

Copied from `CLAUDE.md` / the design spec — every task's requirements include these:

- **PII-free push, always.** The payload is the existing generic copy (`body: "Open the app to see what's new."`, `data: { type: "message" }`). No sender identity, no message content, no avatar ever enters a push payload. Do NOT change `notificationPushPayload`'s body/data shape.
- **Push is fire-and-forget.** It MUST NOT block, delay, or throw into the message-create request/response. `dispatchChatMessagePush` stays `void` and swallows its own errors.
- **Suppression gates = mute + global opt-out ONLY.** Do not add block/suspension/active-session checks (documented follow-ups, out of scope).
- **Row-less.** Do NOT write an `app_notifications` row for chat messages (would bypass mute via the generic push bridge and double-dispatch).
- **No contract / model / migration change.** `"message"` is already in `packages/contract/src/push.ts` `PUSH_EVENT_TYPES`; the opt-out endpoint already accepts it. Touch neither the contract nor any migration.
- **Logging policy.** `info`/`error` are message-only; raw errors go on `logger.debug({ err }, "…")` (data-object FIRST). Reuse the existing log lines in `dispatchChatMessagePush`.
- **Reuse the existing member query.** The handler already selects active `memberRows` for the socket emit; the push loop reuses that list. No extra query. Exclude the sender (`c.var.auth!.userId`).
- **Definition of done:** `pnpm -r typecheck` and `pnpm --filter @agora/api test` (unit) pass; the new integration file passes against `TEST_DATABASE_URL`.

---

### Task 1: Register the `"message"` push type

**Files:**
- Modify: `apps/api/src/lib/push/dispatch.ts` (the `PUSH_TITLES` map, ~line 49)
- Test: `apps/api/src/lib/push/dispatch.test.ts` (the existing `describe("notificationPushPayload", …)` block)

**Interfaces:**
- Consumes: existing `notificationPushPayload(type: string): PushPayload | null`.
- Produces: `notificationPushPayload("message")` now returns `{ title: "New message", body: "Open the app to see what's new.", data: { type: "message" } }` (was `null`). Task 2 relies on this being non-null.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/lib/push/dispatch.test.ts`, inside the existing `describe("notificationPushPayload", …)` block, add:

```ts
  it("produces a payload for the chat 'message' type", () => {
    expect(notificationPushPayload("message")).toEqual({
      title: "New message",
      body: "Open the app to see what's new.",
      data: { type: "message" },
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run src/lib/push/dispatch.test.ts`
Expected: FAIL — the new case gets `null` (received `null`, expected the object).

- [ ] **Step 3: Add the `"message"` entry to `PUSH_TITLES`**

In `apps/api/src/lib/push/dispatch.ts`, add one line to the `PUSH_TITLES` object (keep the existing entries; append after `"space-membership-approved"`):

```ts
  "space-membership-approved": "Membership approved",
  "message": "New message",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run src/lib/push/dispatch.test.ts`
Expected: PASS — all `notificationPushPayload` cases green, including the new one and the existing "returns null for SILENT types" case (unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/push/dispatch.ts apps/api/src/lib/push/dispatch.test.ts
git commit -m "feat(push): register 'message' as a push-worthy type (New message)"
```

---

### Task 2: Awaitable chat push + fan-out wiring

**Files:**
- Modify: `apps/api/src/lib/push/index.ts` (extract `sendChatMessagePush`; `dispatchChatMessagePush` delegates)
- Modify: `apps/api/src/routes/chat.ts` (import + fan-out loop after `emitMessageCreated`)
- Test: `apps/api/test/integration/chat-message-push.test.ts` (NEW)

**Interfaces:**
- Consumes: Task 1's non-null `notificationPushPayload("message")`; existing `loadDisabledTypes`/`isTypeDisabled` (`lib/notification-prefs.ts`), `isConversationMutedForUser` (`lib/push/index.ts`), `dispatchToUser` (`lib/push/index.ts`).
- Produces:
  - `sendChatMessagePush(projectId: string, userId: string, conversationId: string): Promise<void>` — **exported, awaitable** — runs the decision (payload present → not opted-out → not muted) then `dispatchToUser`. This is what the integration test awaits.
  - `dispatchChatMessagePush(projectId, userId, conversationId): void` — unchanged signature/behavior (fire-and-forget wrapper that calls `sendChatMessagePush(...).catch(…)`).

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/chat-message-push.test.ts`. It mirrors the seeding in `push-dispatch.test.ts` (per-project VAPID integration + a web device) and `conversation-mute.test.ts` (group conversation + mute via API), and asserts the mute/opt-out decision at the `webpush.sendNotification` boundary. It imports `sendChatMessagePush`, which does not exist yet (compile/run failure = the RED).

```ts
// apps/api/test/integration/chat-message-push.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import webpush from "web-push";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { pushDevices, projectIntegrations } from "../../src/db/schema/index.js";
import { sendChatMessagePush } from "../../src/lib/push/index.js";

describe("chat-message push fan-out (integration)", () => {
  let projectId: string; let B: string;
  let alice: { id: string; token: string };   // sender
  let bob: { id: string; token: string };      // recipient (has a device)
  let conversationId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [alice, bob] = await Promise.all([createUser(projectId), createUser(projectId)]);
    const keys = webpush.generateVAPIDKeys();
    await getDb().insert(projectIntegrations).values({
      projectId, name: "vapid",
      data: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:t@x" },
    });
    await getDb().insert(pushDevices).values({
      projectId, userId: bob.id, platform: "web",
      subscription: { endpoint: "https://push.example/bob", keys: { p256dh: "p", auth: "a" } },
    });
    const g = await api("POST", `${B}/chat/conversations`, { token: alice.token, body: { type: "group", name: "Crew", memberIds: [bob.id] } });
    conversationId = g.body.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  // Reset any mute/opt-out state bob accrued in a prior case, so cases are order-independent.
  beforeEach(async () => {
    await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: bob.token, body: { duration: null } });
    await api("PUT", `${B}/push-notifications/preferences`, { token: bob.token, body: { disabledTypes: [] } });
  });

  it("dispatches to a member who is neither muted nor opted-out", async () => {
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await sendChatMessagePush(projectId, bob.id, conversationId);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("suppresses when the recipient muted the conversation forever", async () => {
    await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: bob.token, body: { duration: "forever" } });
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await sendChatMessagePush(projectId, bob.id, conversationId);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("suppresses when the recipient has a future timed mute", async () => {
    await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: bob.token, body: { duration: "8h" } });
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await sendChatMessagePush(projectId, bob.id, conversationId);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("suppresses when the recipient globally opted out of 'message'", async () => {
    await api("PUT", `${B}/push-notifications/preferences`, { token: bob.token, body: { disabledTypes: ["message"] } });
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await sendChatMessagePush(projectId, bob.id, conversationId);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("POST /messages still succeeds with the fan-out wired in (route smoke test)", async () => {
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    const res = await api("POST", `${B}/chat/conversations/${conversationId}/messages`, { token: alice.token, body: { content: "hi crew" } });
    expect(res.status).toBe(201);
    expect(res.body.content).toBe("hi crew");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts chat-message-push`
Expected: FAIL — `sendChatMessagePush` is not exported from `lib/push/index.js` (import/compile error), and even if imported the `"message"` payload would need Task 1 (already merged). Confirm the failure is the missing export.

- [ ] **Step 3: Extract `sendChatMessagePush` in `lib/push/index.ts`**

Replace the existing `dispatchChatMessagePush` function (the one whose async IIFE does the opt-out + mute checks) with an awaitable core plus a thin fire-and-forget wrapper. Keep the doc-comment intent:

```ts
/** Awaitable chat `message` push: same suppressed-payload + global-opt-out gate as the generic bridge,
 *  plus a per-conversation mute check. Exported so the decision is testable; the request path uses the
 *  fire-and-forget `dispatchChatMessagePush` wrapper below. */
export async function sendChatMessagePush(projectId: string, userId: string, conversationId: string): Promise<void> {
  const payload = notificationPushPayload("message");
  if (!payload) return; // suppressed type → in-app only
  const disabled = await loadDisabledTypes(projectId, userId);
  if (isTypeDisabled(disabled, "message")) return; // global chat-push opt-out (#1)
  if (await isConversationMutedForUser(projectId, conversationId, userId)) return; // per-conversation mute (#2)
  await dispatchToUser(projectId, userId, payload);
}

/** Fire-and-forget bridge for chat `message` push — never blocks/throws into the request. */
export function dispatchChatMessagePush(projectId: string, userId: string, conversationId: string): void {
  sendChatMessagePush(projectId, userId, conversationId).catch((err) => {
    logger.error("push: chat message dispatch failed");
    logger.debug({ err, conversationId }, "push: chat message dispatch failed");
  });
}
```

(Leave `isConversationMutedForUser`, `dispatchNotificationPush`, `dispatchToUser`, imports, etc. untouched — `loadDisabledTypes`/`isTypeDisabled`/`isConversationMuted` are already imported.)

- [ ] **Step 4: Wire the fan-out in `routes/chat.ts`**

Add the import (group it with the other `../lib/…` imports at the top of the file):

```ts
import { dispatchChatMessagePush } from "../lib/push/index.js";
```

In the `POST /conversations/:id/messages` handler, immediately AFTER the existing socket fan-out line
`emitMessageCreated(convo.id, c.var.projectId, memberRows.map((m) => m.userId), shaped);`, add:

```ts
    // Fan out background push to every OTHER active member (fire-and-forget; honors mute + opt-out).
    for (const m of memberRows) {
      if (m.userId !== c.var.auth!.userId) dispatchChatMessagePush(c.var.projectId, m.userId, convo.id);
    }
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts chat-message-push`
Expected: PASS — all five cases green (dispatch when clear; suppressed on forever-mute, timed-mute, opt-out; route POST returns 201).

- [ ] **Step 6: Typecheck + full unit suite**

Run: `pnpm -r typecheck && pnpm --filter @agora/api test`
Expected: typecheck clean across packages; unit suite green (Task 1's `dispatch.test.ts` case included).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/push/index.ts apps/api/src/routes/chat.ts apps/api/test/integration/chat-message-push.test.ts
git commit -m "feat(chat): fan out push to conversation members on message send (honors mute + opt-out)"
```

---

### Task 3: Docs

**Files:**
- Modify: `CHANGELOG.md` (repo root, `## [Unreleased]`)
- Modify: `docs/MANIFEST.md` (the chat `POST /conversations/:id/messages` entry / push-notifications section)

**Interfaces:** none (documentation only).

- [ ] **Step 1: CHANGELOG entry**

Under `## [Unreleased]` → `### Added` (create the section if absent), add:

```markdown
- **Chat push notifications** — sending a chat message now fans out a background push notification to
  every other active member of the conversation. Respects the recipient's per-conversation mute and the
  global chat-push opt-out (`push_notification_preferences`). Payload is PII-free (generic copy,
  `data.type = "message"`); no-op when no push provider is configured.
```

- [ ] **Step 2: MANIFEST note**

In `docs/MANIFEST.md`, find the chat `POST /conversations/:id/messages` entry (or the push-notifications section) and add a one-line note that on success it fans out `message` push to other active members, subject to per-conversation mute and the global opt-out. Do not invent a new endpoint or socket event — there is none. Confirm `"message"` is already listed among the push event types; if a push-event-type list exists in MANIFEST, ensure `message` is present (it already is in the contract).

- [ ] **Step 3: Verify docs match the code**

Re-read both edits against Task 1/2 behavior: PII-free payload, mute + opt-out gates only, no new endpoint/migration/contract change. Fix any wording that overstates (e.g. don't claim an inbox row is written).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/MANIFEST.md
git commit -m "docs: chat-message push fan-out (CHANGELOG + MANIFEST)"
```

---

## Self-Review (author checklist — completed)

- **Spec coverage:** register `message` type (Task 1) ✓; fan-out wiring + mute/opt-out gates + sender exclusion (Task 2) ✓; PII-free/no-migration/no-contract constraints (Global Constraints + Task 2) ✓; docs (Task 3) ✓.
- **Placeholder scan:** no TBD/TODO; every code/test step shows the exact code.
- **Type consistency:** `sendChatMessagePush(projectId, userId, conversationId): Promise<void>` and `dispatchChatMessagePush(…): void` are named identically in the interface blocks, the index.ts edit, and the test import. The route calls `dispatchChatMessagePush` (void); the test awaits `sendChatMessagePush`.
- **Ambiguity note for the implementer:** sender-exclusion is asserted by the route's `m.userId !== c.var.auth!.userId` guard (visible in the diff) plus the route smoke test; it is not asserted per-user through the fire-and-forget path (unobservable end-to-end), which is why the decision cases test `sendChatMessagePush` directly. This is intentional, not a gap.
