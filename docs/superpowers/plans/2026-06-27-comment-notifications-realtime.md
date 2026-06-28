# Comment Notifications Realtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver app-notifications live over the existing socket (`notification:created`), fix one comment-reply generation gap, and make socket fan-out cross-replica via a Redis adapter.

**Architecture:** Generation already exists in `lib/notifications.ts` (the `insert()` choke point + `notifyOnComment`). We (1) make a reply notify the entity owner too, (2) add a project-scoped per-user socket room with auto-join + a `notification:created` event + an `emitToUser()` fan-out helper, (3) call `emitToUser` from the shared `insert()` so *every* notification type goes live, and (4) attach `@socket.io/redis-adapter` when `REDIS_URL` is set so emits cross replicas (also fixing chat).

**Tech Stack:** TypeScript, Hono, socket.io 4.8, ioredis, Drizzle/postgres.js, vitest (integration suite against real Postgres), `socket.io-client` for the realtime test.

## Global Constraints

- **Logging:** use the shared `logger` (`lib/logger.ts`), never `console.*`. `info`/`error` are message-only; raw `{ err }` only on `debug`. Pino arg order is data-object-FIRST: `logger.debug({ err }, "msg")`.
- **Fail closed / fail-soft infra:** the Redis adapter is gated on `REDIS_URL` and must degrade to single-process fan-out (current behavior) when unset or unavailable — never throw on boot.
- **No cross-tenant leakage:** the per-user room key MUST be project-namespaced (`user:<projectId>:<userId>`).
- **Notification metadata shapes are contract** — match the SDK 1:1 (already do); do not change existing metadata fields.
- **Run before done:** `pnpm -r typecheck` and `pnpm test` (run integration with `TEST_DATABASE_URL` set, prefixed with `TMPDIR="$HOME/.cache/agora-tmp"` per CLAUDE.md). Commit per task.
- **No mid-task commits beyond the per-task commit step**, and do NOT push — Jenova approves the final state.
- All commits DCO-signed (`git commit -s`) per repo policy.

---

### Task 1: Reply notifies the entity owner too (generation)

Make a reply generate **both** `comment-reply` (parent author) **and** `entity-comment` (entity owner), deduped via the existing `notified` Set.

**Files:**
- Modify: `apps/api/src/lib/notifications.ts` (the `if (comment.parentId)` branch in `notifyOnComment`, ~lines 134-163)
- Test: `apps/api/test/integration/notifications.test.ts`

**Interfaces:**
- Consumes: existing `insert(projectId, recipientId, actorId, type, action, metadata)` (self-notify guard already inside), `entityMeta` object, `notified: Set<string>` — all already in scope in `notifyOnComment`.
- Produces: no new exported symbol; behavior change only.

- [ ] **Step 1: Write the failing tests**

Add these to `apps/api/test/integration/notifications.test.ts`, inside the top-level `describe`. They reuse the file's existing `newEntity`, `ofType`, `api`, `B`, `alice`, `bob`, `carol` helpers.

```ts
it("a reply ALSO notifies the entity owner (entity-comment) plus the parent author (comment-reply)", async () => {
  // alice owns the entity; bob writes the parent; carol replies → carol notifies BOTH alice and bob
  const e = await newEntity(alice);
  const parent = await api("POST", `${B}/comments`, { token: bob.token, body: { entityId: e.id, content: "parent" } });
  const reply = await api("POST", `${B}/comments`, {
    token: carol.token,
    body: { entityId: e.id, parentId: parent.body.id, content: "a reply" },
  });
  expect(reply.status).toBe(201);

  const bobReply = (await ofType(bob, "comment-reply")).filter((n) => n.metadata.replyId === reply.body.id);
  expect(bobReply).toHaveLength(1);
  expect(bobReply[0].metadata).toMatchObject({ commentId: parent.body.id, replyId: reply.body.id, initiatorId: carol.id });

  const aliceEntityComment = (await ofType(alice, "entity-comment")).filter((n) => n.metadata.commentId === reply.body.id);
  expect(aliceEntityComment).toHaveLength(1);
  expect(aliceEntityComment[0].metadata).toMatchObject({ entityId: e.id, commentId: reply.body.id, initiatorId: carol.id });
});

it("reply where the entity owner IS the parent author yields ONE row (comment-reply, not entity-comment)", async () => {
  // alice owns the entity AND wrote the parent; bob replies → bob notifies alice exactly once, as comment-reply
  const e = await newEntity(alice);
  const parent = await api("POST", `${B}/comments`, { token: alice.token, body: { entityId: e.id, content: "my own parent" } });
  const reply = await api("POST", `${B}/comments`, {
    token: bob.token,
    body: { entityId: e.id, parentId: parent.body.id, content: "reply to alice" },
  });
  expect(reply.status).toBe(201);

  expect((await ofType(alice, "comment-reply")).filter((n) => n.metadata.replyId === reply.body.id)).toHaveLength(1);
  expect((await ofType(alice, "entity-comment")).filter((n) => n.metadata.commentId === reply.body.id)).toHaveLength(0);
});

it("a self-reply on your own entity notifies no one", async () => {
  // alice owns the entity, wrote the parent, and replies to herself → zero rows
  const e = await newEntity(alice);
  const parent = await api("POST", `${B}/comments`, { token: alice.token, body: { entityId: e.id, content: "p" } });
  const reply = await api("POST", `${B}/comments`, {
    token: alice.token,
    body: { entityId: e.id, parentId: parent.body.id, content: "self reply" },
  });
  expect(reply.status).toBe(201);
  expect((await ofType(alice, "comment-reply")).filter((n) => n.metadata.replyId === reply.body.id)).toHaveLength(0);
  expect((await ofType(alice, "entity-comment")).filter((n) => n.metadata.commentId === reply.body.id)).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- notifications`
Expected: the first new test FAILS (alice gets 0 `entity-comment` rows for the reply — current code only notifies the parent author). The other two may already pass.

- [ ] **Step 3: Implement — add the entity-owner notify in the reply branch**

In `apps/api/src/lib/notifications.ts`, replace the reply branch (the `if (comment.parentId) { ... }` block, ~lines 134-151) with the version below. The `else` top-level branch and the mentions loop are unchanged.

```ts
    if (comment.parentId) {
      // Reply → notify the parent comment's author …
      const [parent] = await db
        .select({ userId: comments.userId, content: comments.content })
        .from(comments)
        .where(and(eq(comments.projectId, projectId), eq(comments.id, comment.parentId)))
        .limit(1);
      if (parent?.userId && !notified.has(parent.userId)) {
        await insert(projectId, parent.userId, actorId, "comment-reply", "open-comment", {
          ...entityMeta,
          commentId: comment.parentId,
          commentContent: parent.content,
          replyId: comment.id,
          replyContent: comment.content,
          ...actor,
        });
        notified.add(parent.userId);
      }
      // … AND the entity author (deduped — skipped if they're the actor or already notified above).
      if (entity.userId && !notified.has(entity.userId)) {
        await insert(projectId, entity.userId, actorId, "entity-comment", "open-comment", {
          ...entityMeta,
          commentId: comment.id,
          commentContent: comment.content,
          ...actor,
        });
        notified.add(entity.userId);
      }
    } else {
```

Also update the function's doc comment (~line 106) to read:
```ts
/**
 * On comment creation: notify the entity author and (for a reply) the parent-comment author,
 * deduped, plus any mentioned users. Pass the freshly-inserted comment row.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- notifications`
Expected: PASS (all notification tests, including the three new ones).

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/notifications.ts apps/api/test/integration/notifications.test.ts
git commit -s -m "feat(notifications): a reply also notifies the entity owner (deduped)"
```

---

### Task 2: Per-user room, `notification:created` event, and `emitToUser()`

Add a project-scoped per-user room that every authenticated socket auto-joins, a new server→client event, and a fan-out helper mirroring `emitToConversation`.

**Files:**
- Modify: `apps/api/src/realtime/socket.ts`

**Interfaces:**
- Consumes: existing `ioRef`, `room()` pattern, `socket.data.{userId,projectId}` (set by the auth middleware), and `shapeNotification`'s return shape (a plain object: `{ id, userId, type, action, isRead, metadata, createdAt }`).
- Produces:
  - `export function emitToUser(projectId: string, userId: string, event: keyof ServerToClientEvents, ...args): void` — fan a server event to all of a user's sockets in `user:<projectId>:<userId>`.
  - `ServerToClientEvents["notification:created"]: (n: ShapedNotification) => void` where `ShapedNotification = ReturnType<typeof import("../lib/shape.js").shapeNotification>`.

- [ ] **Step 1: Add the event to the `ServerToClientEvents` interface**

In `apps/api/src/realtime/socket.ts`, add the import near the other `lib` imports (top of file):
```ts
import type { shapeNotification } from "../lib/shape.js";
```
Then add this member to the `ServerToClientEvents` interface (after `"conversation:deleted"`):
```ts
  "notification:created": (n: ReturnType<typeof shapeNotification>) => void;
```

- [ ] **Step 2: Add the per-user room key helper**

Next to the existing `const room = (conversationId: string) => \`conversation:${conversationId}\`;` (~line 45), add:
```ts
const userRoom = (projectId: string, userId: string) => `user:${projectId}:${userId}`;
```

- [ ] **Step 3: Auto-join the per-user room on connection**

In `attachRealtime`, inside `io.on("connection", (socket) => { ... })`, immediately after the `socketActiveConnections.add(1)` / `disconnect` lines (~line 124) and before the first `safeOn(...)`, add:
```ts
    // Per-user room for app-notification fan-out (auth middleware has set socket.data). Project-scoped
    // so a notification never crosses tenants. All of a user's tabs/devices share this room.
    socket.join(userRoom(socket.data.projectId, socket.data.userId));
```

- [ ] **Step 4: Add the `emitToUser` fan-out helper**

At the end of the file, after `emitToConversation`, add:
```ts
// REST/business code calls this to push a notification to all of a user's connected sockets.
// No-op if the socket server isn't attached (e.g. unit tests). With the Redis adapter (Task 4)
// attached, this crosses replicas. e.g.:
//   emitToUser(projectId, recipientId, "notification:created", shapedNotification)
export function emitToUser<E extends keyof ServerToClientEvents>(
  projectId: string,
  userId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  ioRef?.to(userRoom(projectId, userId)).emit(event, ...args);
}
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: no errors. (No standalone unit test here — Task 3 wires the caller and Task 5 proves delivery end-to-end over a real socket.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/realtime/socket.ts
git commit -s -m "feat(realtime): per-user room + notification:created event + emitToUser()"
```

---

### Task 3: Fan out every notification at the `insert()` choke point

Emit `notification:created` from the shared `insert()` so all notification types (comment, follow, reaction, steward, …) are delivered live.

**Files:**
- Modify: `apps/api/src/lib/notifications.ts` (`insert()`, ~lines 48-61; imports ~line 22)

**Interfaces:**
- Consumes: `emitToUser` from Task 2; `shapeNotification` (already imported); `recipientId`, `projectId` (already params of `insert`).
- Produces: no new symbol; side-effect (socket emit) added to `insert`.

- [ ] **Step 1: Import `emitToUser`**

In `apps/api/src/lib/notifications.ts`, add after the `webhooks` import (~line 22):
```ts
import { emitToUser } from "../realtime/socket.js";
```
(No import cycle: `realtime/socket.ts` does not import `lib/notifications.ts` — it only `import type`s `shapeNotification` from `lib/shape.ts`.)

- [ ] **Step 2: Emit in `insert()`**

Replace the body tail of `insert()` (the `if (row) ...` line, ~line 60) with:
```ts
  if (row) {
    const shaped = shapeNotification(row);
    // Push-notification bridge: fire-and-forget broadcast webhook (no-op unless subscribed).
    webhooks.broadcast(projectId, "notification.created", shaped);
    // Realtime: live-deliver to the recipient's open sockets (no-op until the socket server is attached).
    emitToUser(projectId, recipientId, "notification:created", shaped);
  }
```
Also update the file-header "Realtime:" note (~lines 14-15) to:
```ts
// Realtime: delivered over socket.io via emitToUser() in insert() — the recipient's open sockets get a
// `notification:created` event with the shaped row. Falls back to inbox polling when no socket is open.
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Run the notification generation suite (no regression)**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- notifications`
Expected: PASS. (Delivery itself is covered in Task 5; here we confirm the emit doesn't break generation — `emitToUser` is a no-op when no socket server is attached, as in this suite.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/notifications.ts
git commit -s -m "feat(notifications): live-deliver every notification via notification:created"
```

---

### Task 4: Redis adapter for cross-replica socket fan-out

Attach `@socket.io/redis-adapter` when `REDIS_URL` is set so emits reach sockets on other replicas (fixes notifications AND chat). Fail-soft: no Redis → unchanged single-process behavior.

**Files:**
- Modify: `apps/api/package.json` (add dependency)
- Modify: `apps/api/src/realtime/socket.ts` (`attachRealtime`)

**Interfaces:**
- Consumes: `getRedis()` from `../lib/redis.js` (returns a shared `ioredis` client or `null`), `logger`.
- Produces: no new exported symbol; `io.adapter(...)` configured in-place.

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd apps/api && pnpm add @socket.io/redis-adapter@^8
```
Expected: `@socket.io/redis-adapter` appears under `dependencies` in `apps/api/package.json` and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Import the adapter and the Redis client**

In `apps/api/src/realtime/socket.ts`, add near the top imports:
```ts
import { createAdapter } from "@socket.io/redis-adapter";
import { getRedis } from "../lib/redis.js";
```

- [ ] **Step 3: Attach the adapter in `attachRealtime`**

In `attachRealtime`, immediately after `ioRef = io;` (~line 96) and before `io.use(...)`, add:
```ts
  // Cross-replica fan-out: when REDIS_URL is set, route socket.io rooms through Redis so an emit on
  // one replica reaches sockets connected to another (notifications AND chat). Fail-soft — unset or
  // a construction error leaves the default in-memory adapter (single-process, current behavior).
  try {
    const pub = getRedis();
    if (pub) {
      const sub = pub.duplicate(); // the adapter needs a dedicated subscriber connection
      io.adapter(createAdapter(pub, sub));
      logger.info("socket: redis adapter enabled (cross-replica fan-out)");
    }
  } catch (err) {
    logger.error("socket: redis adapter setup failed; using in-memory adapter");
    logger.debug({ err }, "socket: redis adapter setup failed");
  }
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Confirm no-Redis boot still works (smoke)**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- chat-realtime`
Expected: PASS — the existing realtime suite runs with `REDIS_URL` unset, proving the adapter block is a no-op when Redis is absent (sockets still connect and fan out in-process).

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/realtime/socket.ts
git commit -s -m "feat(realtime): cross-replica socket fan-out via @socket.io/redis-adapter (REDIS_URL-gated)"
```

---

### Task 5: End-to-end realtime delivery test

Prove a recipient's open socket receives `notification:created` when someone comments, and the actor's socket does not.

**Files:**
- Create: `apps/api/test/integration/notifications-realtime.test.ts`

**Interfaces:**
- Consumes: `attachRealtime`, `createApp`, and the `api/createProject/createUser/deleteProject/base` helpers; `socket.io-client`. Mirrors `chat-realtime.test.ts` exactly for server boot + `connect()`/`once()` helpers.

- [ ] **Step 1: Write the test**

Create `apps/api/test/integration/notifications-realtime.test.ts`:
```ts
// E2E: app-notification realtime over socket.io. Boots a real HTTP server + socket.io so a
// socket.io-client can connect over the wire, then drives a REST comment write through the
// in-process api() helper and asserts the recipient's socket gets `notification:created`
// (and the actor's socket does not).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createApp } from "../../src/app.js";
import { attachRealtime } from "../../src/realtime/socket.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

let projectId: string;
let alice: { id: string; token: string }; // entity owner / recipient
let bob: { id: string; token: string };   // commenter / actor
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachRealtime>;
let port: number;

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connectClient(`http://localhost:${port}`, {
      auth: { token },
      query: { projectId },
      transports: ["websocket"],
      reconnection: false,
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

function once(socket: Socket, event: string, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload: unknown) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
  bob = await createUser(projectId);

  const app = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
  });
  io = attachRealtime(server as unknown as Parameters<typeof attachRealtime>[0]);
});

afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("notification realtime (socket.io e2e)", () => {
  it("delivers notification:created to the recipient's socket when someone comments", async () => {
    const aliceSocket = await connect(alice.token);
    try {
      // alice's socket auto-joins user:<projectId>:<alice.id> on connect — give it a beat.
      await settle(200);
      const waiter = once(aliceSocket, "notification:created");

      const e = await api("POST", `${base(projectId)}/entities`, { token: alice.token, body: { title: "t", content: "c" } });
      const c = await api("POST", `${base(projectId)}/comments`, { token: bob.token, body: { entityId: e.body.id, content: "live!" } });
      expect(c.status).toBe(201);

      const note = await waiter;
      expect(note).toMatchObject({
        userId: alice.id,
        type: "entity-comment",
        isRead: false,
      });
      expect(note.metadata).toMatchObject({ entityId: e.body.id, commentId: c.body.id, initiatorId: bob.id });
    } finally {
      aliceSocket.close();
    }
  });

  it("does NOT deliver to the actor's own socket (self-notify suppression)", async () => {
    const bobSocket = await connect(bob.token);
    try {
      await settle(200);
      let received = false;
      bobSocket.on("notification:created", () => { received = true; });

      // bob comments on his OWN entity → no notification row, nothing emitted to bob.
      const e = await api("POST", `${base(projectId)}/entities`, { token: bob.token, body: { title: "t", content: "c" } });
      await api("POST", `${base(projectId)}/comments`, { token: bob.token, body: { entityId: e.body.id, content: "mine" } });

      await settle(600);
      expect(received).toBe(false);
    } finally {
      bobSocket.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- notifications-realtime`
Expected: PASS (both cases). If the first times out, confirm Tasks 2-3 landed (auto-join + `emitToUser` in `insert()`).

- [ ] **Step 3: Full typecheck + unit suite**

Run: `pnpm -r typecheck && cd apps/api && pnpm test`
Expected: no type errors; unit suite green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/integration/notifications-realtime.test.ts
git commit -s -m "test(realtime): e2e notification:created delivery + self-notify suppression"
```

---

### Task 6: Changelog + docs

Record the contract addition so the SDK side and MANIFEST stay in sync.

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/MANIFEST.md` (socket events section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the changelog entries**

Under `## [Unreleased]` in `CHANGELOG.md`, add (creating the section headers if absent):
```markdown
### Added
- Realtime app-notifications: a `notification:created` socket.io event (full shaped notification row)
  fans out to a per-user room `user:<projectId>:<userId>` that every authenticated socket auto-joins,
  so the bell/badge updates live for every notification type. Optional cross-replica fan-out via
  `@socket.io/redis-adapter`, enabled when `REDIS_URL` is set (also makes chat fan-out cross-replica).

### Changed
- A comment reply now notifies the entity owner (`entity-comment`) in addition to the parent comment
  author (`comment-reply`), deduped when they are the same user.
```

- [ ] **Step 2: Document the socket event in MANIFEST**

In `docs/MANIFEST.md`, find the socket.io server→client events list and add a row/line for:
```
notification:created → full UnifiedAppNotification (room: user:<projectId>:<userId>, auto-joined on connect)
```
Match the surrounding table/list format exactly (check the existing `message:*` entries and mirror their style).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/MANIFEST.md
git commit -s -m "docs(notifications): changelog + MANIFEST for notification:created + reply fan-out"
```

---

## Self-Review

**Spec coverage:**
- §2 generation (entity-comment / comment-reply / comment-mention) — already implemented; the one decided change (reply → entity owner too) is Task 1. ✅
- §2 suppression rules (self-notify, reply dedup, mention dedup) — preserved/extended in Task 1, asserted by its tests. ✅
- §3 per-user room (`user:<userId>`, project-namespaced) + auto-join — Task 2. ✅
- §3 `notification:created` event with full row — Task 2 (event) + Task 3 (emit) + Task 5 (proof). ✅
- §3 decision: no `notification:unread_count` — intentionally omitted (locked decision). ✅
- Cross-replica decision (Redis adapter now) — Task 4. ✅
- Contract sync (MANIFEST/CHANGELOG) — Task 6. ✅
- SDK-side wiring (event union + slice) is explicitly the SDK repo's follow-up, out of this plan.

**Placeholder scan:** no TBD/TODO; every code step shows full code; MANIFEST step references concrete existing entries to mirror. ✅

**Type consistency:** `emitToUser(projectId, userId, event, ...args)` defined in Task 2, imported and called identically in Task 3. `userRoom(projectId, userId)` used in both the auto-join (Task 2 Step 3) and `emitToUser` (Task 2 Step 4). Event name `"notification:created"` identical across Tasks 2, 3, 5, 6. Shaped payload (`ReturnType<typeof shapeNotification>`) is the same object asserted in Task 5. ✅
