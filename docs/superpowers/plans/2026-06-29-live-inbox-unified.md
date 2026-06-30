# Live Inbox + Realtime Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat inbox live (fan `message:created` to every member's user room, add a `ConversationPreview` shaper + `/preview` endpoint, emit `conversation:created` on new conversations), close the connections realtime gap (route `connections.ts` through `lib/notifications.ts` so requests/accepts fan out via the existing `notification:created` + webhook), add `?after=` reconnect catch-up to the messages endpoint, and add a keyset index.

**Architecture:** Pure shaping/truncation/room-name helpers are unit-tested without a DB. The chat route gets one shared `buildConversationPreview` helper used by the list endpoint, the new preview endpoint, and (zero-state) the `conversation:created` emit. The socket layer gets one fan-out helper that unions the conversation room with member user rooms. Connections reuse the existing notification pipeline — no new socket events, no SDK fork.

**Tech Stack:** Hono, socket.io (+ optional Redis adapter), Drizzle ORM, vitest (unit + real-Postgres integration), Postgres (keyset index migration).

**Source spec:** `docs/superpowers/specs/2026-06-29-live-inbox-unified-design.md`

## Global Constraints

- Pure/branching logic ships with unit tests in the same change (`src/**/*.test.ts`, vitest, no DB).
- DB-backed / realtime behavior gets an integration test under `test/integration/**` (real Postgres, isolated by `project_id`; socket tests boot a real HTTP + socket.io server — mirror `test/integration/chat-realtime.test.ts`).
- Use the shared `logger`; `info`/`error` carry a **message string only**, raw detail (`{ err }`) goes on `debug`. Pino arg order is **data-object first**: `logger.debug({ err }, "msg")`.
- Socket event names are contract — byte-identical to the SDK (`@replyke/core/types/socket.ts`). `conversation:created` is the exact new event name. **Connections do NOT get dedicated socket events** — they ride the existing `notification:created` with notification `type` = `connection-request` / `connection-accepted`.
- `otherMembers` is attached on the **list** and **`/preview`** endpoints only. The detail endpoint `GET /chat/conversations/:id` stays unchanged (non-goal).
- Migrations: apply with `pnpm db:migrate:run` (NOT `db:migrate`). New custom SQL is idempotent (`CREATE INDEX IF NOT EXISTS`). **The next free migration number is `0054`** (`0053_events` already exists). The journal `when` must be strictly greater than the current max **`1781934611651`** → use **`1781934611652`**.
- `pnpm -r typecheck` and `pnpm --filter @agora/api test` (unit) must pass before any task is done. Integration runs are gated behind `TEST_DATABASE_URL`.
- Run vitest from `apps/api`: unit `pnpm test -- <pattern>`; integration `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <name>` (the bare `pnpm test:integration -- <name>` does NOT filter). For `ENOSPC`, prefix `TMPDIR="$HOME/.cache/agora-tmp"`.

---

## File Structure

| File | Responsibility | Tasks |
|------|----------------|-------|
| `apps/api/src/lib/shape.ts` | Add `truncateMessageContent`, `pickOtherMembers`, `shapeConversationPreview` (pure) | 1 |
| `apps/api/src/lib/shape-preview.test.ts` | Unit tests for the three shapers | 1 |
| `apps/api/src/realtime/socket.ts` | Add `messageCreatedRooms`, `emitMessageCreated`; add `conversation:created` event type | 2 |
| `apps/api/src/realtime/socket.test.ts` | Unit test for `messageCreatedRooms` | 2 |
| `apps/api/src/routes/chat.ts` | `buildConversationPreview` + `emitConversationCreated` helpers; `/preview` endpoint; list → preview shape; message fan-out; `?after=` cursor | 3, 4, 6 |
| `apps/api/test/integration/chat-preview.test.ts` | Integration: `/preview` + list shape | 3 |
| `apps/api/test/integration/chat-realtime.test.ts` | Append: inbox-observer fan-out + `conversation:created` | 4 |
| `apps/api/test/integration/chat-messages-after.test.ts` | Integration: `?after=` cursor | 6 |
| `apps/api/src/lib/notifications.ts` | Add `notifyOnConnectionRequest`, `notifyOnConnectionAccept` | 5 |
| `apps/api/src/routes/connections.ts` | Replace local `notify()` with the lib helpers | 5 |
| `apps/api/test/integration/connections-realtime.test.ts` | Integration: connection request → `notification:created` | 5 |
| `apps/api/drizzle/0054_conversations_keyset_idx.sql` | Keyset index (new migration) | 7 |
| `apps/api/drizzle/meta/_journal.json` | Append journal entry idx 54 | 7 |
| `CHANGELOG.md` | Document Added/Changed/Fixed | 8 |

---

### Task 1: Pure preview shapers (truncation, otherMembers, ConversationPreview)

**Suggested model:** cheap (transcription — complete code below, 1 file + test).

**Files:**
- Modify: `apps/api/src/lib/shape.ts` (add helpers immediately after `shapeConversation`, which ends at line 520)
- Test: `apps/api/src/lib/shape-preview.test.ts`

**Interfaces:**
- Produces:
  - `truncateMessageContent<T extends { content?: unknown }>(msg: T, max?: number): T` — codepoint-safe truncation of a shaped message's `content` (default max 100).
  - `pickOtherMembers(rows: Array<{ id: string; name: string | null; username: string | null; avatar: string | null }>, max?: number): Array<{ id: string; name: string | null; username: string | null; avatar: string | null }>` — caps to `max` (default 5), projects the 4 inbox fields.
  - `shapeConversationPreview(row: ConversationRow, opts: { unreadCount: number; lastMessage: Record<string, unknown> | null; otherMembers: Array<{ id: string; name: string | null; username: string | null; avatar: string | null }>; currentMember?: unknown })` — base conversation + `unreadCount` + truncated `lastMessage` + `otherMembers`.
- Consumes: existing `shapeConversation` + the module-local `ConversationRow` type alias (`shape.ts:492`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/shape-preview.test.ts
import { describe, it, expect } from "vitest";
import { truncateMessageContent, pickOtherMembers, shapeConversationPreview } from "./shape.js";

const convoRow = {
  id: "c1", projectId: "p1", type: "group", name: null, description: null, spaceId: null,
  createdById: "u1", avatarFileId: null, lastMessageAt: null, postingPermission: null,
  metadata: {}, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
} as any;

describe("truncateMessageContent", () => {
  it("truncates content longer than max to exactly max characters", () => {
    const out = truncateMessageContent({ content: "x".repeat(150) }, 100);
    expect((out.content as string).length).toBe(100);
  });
  it("leaves short content untouched (same reference)", () => {
    const msg = { content: "hi" };
    expect(truncateMessageContent(msg, 100)).toBe(msg);
  });
  it("is codepoint-safe (does not split a surrogate pair at the boundary)", () => {
    const out = truncateMessageContent({ content: "😀".repeat(150) }, 100);
    expect([...(out.content as string)].length).toBe(100); // 100 whole emoji, not 50 split ones
  });
  it("ignores non-string / null content", () => {
    const msg = { content: null };
    expect(truncateMessageContent(msg as any, 100)).toBe(msg);
  });
});

describe("pickOtherMembers", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, name: `N${i}`, username: `n${i}`, avatar: null }));
  it("caps at max (default 5) and projects the inbox fields", () => {
    const out = pickOtherMembers(mk(7));
    expect(out.length).toBe(5);
    expect(out[0]).toEqual({ id: "u0", name: "N0", username: "n0", avatar: null });
  });
  it("returns all when fewer than max", () => {
    expect(pickOtherMembers(mk(2)).length).toBe(2);
  });
});

describe("shapeConversationPreview", () => {
  it("includes unreadCount, otherMembers, and a truncated lastMessage", () => {
    const preview = shapeConversationPreview(convoRow, {
      unreadCount: 3,
      lastMessage: { content: "y".repeat(150) },
      otherMembers: [{ id: "u2", name: "Bo", username: "bo", avatar: null }],
    }) as any;
    expect(preview.id).toBe("c1");
    expect(preview.unreadCount).toBe(3);
    expect(preview.otherMembers).toEqual([{ id: "u2", name: "Bo", username: "bo", avatar: null }]);
    expect((preview.lastMessage.content as string).length).toBe(100);
  });
  it("allows a null lastMessage (brand-new conversation)", () => {
    const preview = shapeConversationPreview(convoRow, { unreadCount: 0, lastMessage: null, otherMembers: [] }) as any;
    expect(preview.lastMessage).toBeNull();
    expect(preview.unreadCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- shape-preview`
Expected: FAIL — the three functions are not exported from `shape.js`.

- [ ] **Step 3: Add the helpers to `shape.ts`**

In `apps/api/src/lib/shape.ts`, immediately after `shapeConversation` (ends line 520) and before `shapeConversationMember`, add:

```ts
/** Codepoint-safe truncation of a shaped message's `content` (inbox previews cap at 100 chars). */
export function truncateMessageContent<T extends { content?: unknown }>(msg: T, max = 100): T {
  const content = (msg as { content?: unknown }).content;
  if (typeof content !== "string") return msg;
  const chars = [...content];
  if (chars.length <= max) return msg;
  return { ...msg, content: chars.slice(0, max).join("") };
}

/** Project member profiles to the ≤5 inbox `otherMembers` subset (caller excludes self in the query). */
export function pickOtherMembers(
  rows: Array<{ id: string; name: string | null; username: string | null; avatar: string | null }>,
  max = 5,
): Array<{ id: string; name: string | null; username: string | null; avatar: string | null }> {
  return rows.slice(0, max).map((r) => ({ id: r.id, name: r.name ?? null, username: r.username ?? null, avatar: r.avatar ?? null }));
}

/** Inbox row: base conversation + unreadCount + (truncated) lastMessage + otherMembers. */
export function shapeConversationPreview(
  row: ConversationRow,
  opts: {
    unreadCount: number;
    lastMessage: Record<string, unknown> | null;
    otherMembers: Array<{ id: string; name: string | null; username: string | null; avatar: string | null }>;
    currentMember?: unknown;
  },
) {
  const base = shapeConversation(row, {
    unreadCount: opts.unreadCount,
    lastMessage: opts.lastMessage ? truncateMessageContent(opts.lastMessage, 100) : null,
    ...(opts.currentMember !== undefined ? { currentMember: opts.currentMember } : {}),
  });
  base.otherMembers = opts.otherMembers;
  return base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- shape-preview`
Expected: PASS (8 assertions).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/shape.ts apps/api/src/lib/shape-preview.test.ts
git commit -s -m "feat(shape): add ConversationPreview shaper + truncation/otherMembers helpers"
```

---

### Task 2: Socket fan-out helper + `conversation:created` event

**Suggested model:** cheap (transcription — complete code below, 1 file + test).

**Files:**
- Modify: `apps/api/src/realtime/socket.ts` (`ServerToClientEvents` ends line 35; add helpers after `emitToUser`, which ends line 196)
- Test: `apps/api/src/realtime/socket.test.ts`

**Interfaces:**
- Produces:
  - `messageCreatedRooms(conversationId: string, projectId: string, memberUserIds: string[]): string[]` — `["conversation:{id}", "user:{proj}:{u}", …]`.
  - `emitMessageCreated(conversationId: string, projectId: string, memberUserIds: string[], message: unknown): void` — emits `message:created` to the union of those rooms (one delivery per socket; no-op when `ioRef` is null).
  - `"conversation:created"` added to `ServerToClientEvents`.
- Consumes: the existing module-local `room()` and `userRoom()` helpers (`socket.ts:50,52`), `ioRef` (`socket.ts:96`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/realtime/socket.test.ts
import { describe, it, expect } from "vitest";
import { messageCreatedRooms } from "./socket.js";

describe("messageCreatedRooms", () => {
  it("unions the conversation room with each member's user room", () => {
    expect(messageCreatedRooms("conv1", "proj1", ["a", "b"])).toEqual([
      "conversation:conv1",
      "user:proj1:a",
      "user:proj1:b",
    ]);
  });
  it("returns just the conversation room when there are no members", () => {
    expect(messageCreatedRooms("conv1", "proj1", [])).toEqual(["conversation:conv1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- realtime/socket`
Expected: FAIL — `messageCreatedRooms` not exported.

- [ ] **Step 3: Add the event name + helpers**

In `apps/api/src/realtime/socket.ts`, add `conversation:created` to the `ServerToClientEvents` interface, immediately after the `"conversation:deleted"` line (line 32):

```ts
  // New-conversation fan-out to each member's user room (inbox). Payload = a zero-state ConversationPreview.
  "conversation:created": (preview: unknown) => void;
```

Then, after the `emitToUser` function (ends line 196), append:

```ts
// Rooms a `message:created` must reach: the conversation room (active thread viewers) + every member's
// user room (inbox-only observers, who never join the conversation room). socket.io unions an array of
// rooms, so a socket present in several gets exactly ONE delivery.
export function messageCreatedRooms(conversationId: string, projectId: string, memberUserIds: string[]): string[] {
  return [room(conversationId), ...memberUserIds.map((u) => userRoom(projectId, u))];
}

// Fan a freshly-created message out to active viewers AND inbox observers in one emit. No-op if the
// socket server isn't attached (e.g. unit tests). With the Redis adapter attached, crosses replicas.
export function emitMessageCreated(conversationId: string, projectId: string, memberUserIds: string[], message: unknown): void {
  if (!ioRef) return;
  ioRef.to(messageCreatedRooms(conversationId, projectId, memberUserIds)).emit("message:created", message);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- realtime/socket`
Expected: PASS (2 assertions).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/realtime/socket.ts apps/api/src/realtime/socket.test.ts
git commit -s -m "feat(socket): add message:created fan-out helper + conversation:created event"
```

---

### Task 3: Shared `buildConversationPreview` + `/preview` endpoint + list uses the preview shape

**Suggested model:** standard (multi-edit in chat.ts + integration test).

**Files:**
- Modify: `apps/api/src/routes/chat.ts` (drizzle import line 4; shape import line 13; list handler lines 90-100; add a helper after `userReactionsByMessage` line 58; add the preview route between `/conversations/unread-count` (ends 158) and `/conversations/:id` (159))
- Test: `apps/api/test/integration/chat-preview.test.ts`

**Interfaces:**
- Consumes: `shapeConversationPreview`, `pickOtherMembers` (Task 1); existing `shapeChatMessage`, `shapeConversationMember`, `shapeUser`; existing `ConversationRow`/`MemberRow` type aliases (`chat.ts:26-27`); existing `getConversation`/`requireMember`.
- Produces: `buildConversationPreview(c: any, convo: ConversationRow, member: MemberRow)` (module-private async) → a shaped `ConversationPreview`.

- [ ] **Step 1: Extend the drizzle + shape imports**

In `apps/api/src/routes/chat.ts`:
- Change line 4 from `import { and, eq, desc, asc, count, inArray, gt, sql } from "drizzle-orm";` to:
  ```ts
  import { and, eq, desc, asc, count, inArray, gt, ne, sql } from "drizzle-orm";
  ```
- Change line 13 to add the new shapers:
  ```ts
  import { shapeConversation, shapeConversationMember, shapeChatMessage, shapeFile, shapeUser, loadMessageFiles, shapeConversationPreview, pickOtherMembers } from "../lib/shape.js";
  ```

- [ ] **Step 2: Add the shared helper**

In `apps/api/src/routes/chat.ts`, immediately after `userReactionsByMessage` (ends line 58) and before `export const chatRoutes`, add:

```ts
// Build the inbox ConversationPreview for one (conversation, viewing member): latest message,
// unread count vs the member's lastReadAt, and ≤5 other active members (empty for space chats).
async function buildConversationPreview(c: any, convo: ConversationRow, member: MemberRow) {
  const [last] = await db.select().from(chatMessages)
    .where(eq(chatMessages.conversationId, convo.id)).orderBy(desc(chatMessages.createdAt)).limit(1);
  const [{ u } = { u: 0 }] = await db.select({ u: count() }).from(chatMessages)
    .where(and(eq(chatMessages.conversationId, convo.id), member.lastReadAt ? gt(chatMessages.createdAt, member.lastReadAt) : sql`true`));
  let otherMembers: ReturnType<typeof pickOtherMembers> = [];
  if (convo.type !== "space") {
    const rows = await db.select({ p: profiles }).from(conversationMembers)
      .innerJoin(profiles, eq(profiles.id, conversationMembers.userId))
      .where(and(
        eq(conversationMembers.conversationId, convo.id),
        eq(conversationMembers.isActive, true),
        ne(conversationMembers.userId, member.userId),
      ))
      .limit(5);
    otherMembers = pickOtherMembers(rows.map((r) => shapeUser(r.p) as any));
  }
  return shapeConversationPreview(convo, {
    unreadCount: u,
    lastMessage: last ? (shapeChatMessage(last) as Record<string, unknown>) : null,
    otherMembers,
    currentMember: shapeConversationMember(member),
  });
}
```

- [ ] **Step 3: Use the helper in the list endpoint**

In the `GET /conversations` handler, replace the `const data = await Promise.all(...)` block (lines 90-100) with:

```ts
    const data = await Promise.all(rows.slice(0, limit).map(({ convo, member }) => buildConversationPreview(c, convo, member)));
```

(The surrounding `const hasMore = rows.length > limit;` line 88 and `return c.json({ conversations: data, hasMore });` line 101 stay as-is.)

- [ ] **Step 4: Add the preview endpoint (ABOVE `/conversations/:id`)**

Insert this route immediately after the `/conversations/unread-count` handler (ends line 158) and BEFORE `.get("/conversations/:id", …)` (line 159), so Hono doesn't capture `preview` as an `:id`:

```ts
  .get("/conversations/:id/preview", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    return c.json(await buildConversationPreview(c, convo, member));
  })
```

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Write the integration test**

```ts
// apps/api/test/integration/chat-preview.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversations, conversationMembers } from "../../src/db/schema/index.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("chat conversation preview (integration)", () => {
  let projectId: string; let B: string;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let carol: { id: string; token: string };
  let groupId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [alice, bob, carol] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    // alice creates a group with bob + carol
    const g = await api("POST", `${B}/chat/conversations`, { token: alice.token, body: { type: "group", name: "Crew", memberIds: [bob.id, carol.id] } });
    groupId = g.body.id;
    // alice sends a long message so lastMessage truncation is observable
    await api("POST", `${B}/chat/conversations/${groupId}/messages`, { token: alice.token, body: { content: "z".repeat(150) } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("preview returns unreadCount, otherMembers (≤5, non-self), and a truncated lastMessage", async () => {
    const res = await api("GET", `${B}/chat/conversations/${groupId}/preview`, { token: bob.token });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(groupId);
    expect(typeof res.body.unreadCount).toBe("number");
    // bob's otherMembers = alice + carol (self excluded)
    const ids = res.body.otherMembers.map((m: any) => m.id).sort();
    expect(ids).toEqual([alice.id, carol.id].sort());
    expect(res.body.otherMembers.some((m: any) => m.id === bob.id)).toBe(false);
    expect((res.body.lastMessage.content as string).length).toBe(100);
  });

  it("list endpoint carries the preview shape (otherMembers + truncated lastMessage)", async () => {
    const res = await api("GET", `${B}/chat/conversations?limit=10`, { token: bob.token });
    expect(res.status).toBe(200);
    const row = res.body.conversations.find((x: any) => x.id === groupId);
    expect(Array.isArray(row.otherMembers)).toBe(true);
    expect((row.lastMessage.content as string).length).toBe(100);
  });

  it("otherMembers is empty for a space conversation", async () => {
    // Insert a space-type conversation directly + add bob as a member (bypassing the space plumbing).
    const [sc] = await db.insert(conversations).values({ projectId, type: "space", createdById: bob.id }).returning();
    await db.insert(conversationMembers).values({ projectId, conversationId: sc!.id, userId: bob.id, role: "member" });
    const res = await api("GET", `${B}/chat/conversations/${sc!.id}/preview`, { token: bob.token });
    expect(res.status).toBe(200);
    expect(res.body.otherMembers).toEqual([]);
    await db.delete(conversations).where(eq(conversations.id, sc!.id));
  });

  it("a non-member gets 403 on /preview", async () => {
    const stranger = await createUser(projectId);
    const res = await api("GET", `${B}/chat/conversations/${groupId}/preview`, { token: stranger.token });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 7: Run the integration test**

Run (from `apps/api`): `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts chat-preview`
Expected: PASS (4 tests). (Requires `TEST_DATABASE_URL`.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/test/integration/chat-preview.test.ts
git commit -s -m "feat(chat): ConversationPreview list + /preview endpoint"
```

---

### Task 4: Fan `message:created` to user rooms; emit `conversation:created`

**Suggested model:** standard (the critical bug fix + realtime test; cross-handler reasoning).

**Files:**
- Modify: `apps/api/src/routes/chat.ts` (socket import line 20; message-create emit line 325; group create line 116-117; direct create line 139-140; add `emitConversationCreated` helper near `buildConversationPreview`)
- Test: append to `apps/api/test/integration/chat-realtime.test.ts`

**Interfaces:**
- Consumes: `emitMessageCreated`, `emitToUser` (Task 2 / existing socket exports); `shapeConversationPreview`, `pickOtherMembers`, `shapeUser` (Task 1 / existing); existing `inArray`, `profiles`.

- [ ] **Step 1: Extend the socket import**

In `apps/api/src/routes/chat.ts`, change line 20 from:

```ts
import { emitToConversation } from "../realtime/socket.js";
```

to:

```ts
import { emitToConversation, emitToUser, emitMessageCreated } from "../realtime/socket.js";
```

- [ ] **Step 2: Add the `emitConversationCreated` helper**

In `apps/api/src/routes/chat.ts`, immediately after the `buildConversationPreview` helper (added in Task 3), add:

```ts
// Notify each member's inbox of a new conversation. Zero-state preview (unreadCount 0, no lastMessage);
// otherMembers is the rest of the roster (excluding the recipient). Skipped for space chats. The actor
// is included in memberIds but already has the conversation from the REST response — emitting to their
// user room is harmless (their other tabs upsert it) and keeps the helper simple.
async function emitConversationCreated(c: any, convo: ConversationRow, memberIds: string[]) {
  if (convo.type === "space" || memberIds.length === 0) return;
  const profs = await db.select().from(profiles).where(inArray(profiles.id, memberIds));
  const byId = new Map(profs.map((p) => [p.id, p]));
  for (const recipientId of memberIds) {
    const others = memberIds
      .filter((id) => id !== recipientId)
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => shapeUser(p) as any);
    const preview = shapeConversationPreview(convo, {
      unreadCount: 0,
      lastMessage: null,
      otherMembers: pickOtherMembers(others),
    });
    emitToUser(c.var.projectId, recipientId, "conversation:created", preview);
  }
}
```

- [ ] **Step 3: Fan `message:created` to all members' user rooms**

In the `POST /conversations/:id/messages` handler, replace line 325:

```ts
    emitToConversation(convo.id, "message:created", shaped);
```

with a member lookup + the union fan-out:

```ts
    const memberRows = await db.select({ userId: conversationMembers.userId }).from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.isActive, true)));
    emitMessageCreated(convo.id, c.var.projectId, memberRows.map((m) => m.userId), shaped);
```

(The following `webhooks.broadcast(...)` line 326 and the `thread:reply_count` block stay as-is.)

- [ ] **Step 4: Call `emitConversationCreated` from the group create handler**

In `POST /conversations` (group), after the `logger.info(...)` line (line 116) and before `return c.json(...)` (line 117), add:

```ts
    await emitConversationCreated(c, convo!, memberIds);
```

- [ ] **Step 5: Call `emitConversationCreated` from the direct create handler**

In `POST /conversations/direct`, in the **genuine-create** branch only — after `db.insert(conversationMembers).values([...])` (lines 136-139) and before `return c.json(...)` (line 140), add:

```ts
    await emitConversationCreated(c, convo!, [uid, other]);
```

(Do NOT add it in the get-or-create early-return branch at lines 131-134 — re-emitting on an existing conversation would be a duplicate.)

- [ ] **Step 6: Typecheck**

Run (repo root): `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 7: Append realtime integration tests**

In `apps/api/test/integration/chat-realtime.test.ts`, add these two tests inside the existing `describe("chat realtime (socket.io e2e)", () => { … })` block (the file already provides `connect`, `once`, `settle`, `port`, `alice`, `bob`, `conversationId`):

```ts
  it("delivers message:created to an inbox observer who has NOT joined the conversation room", async () => {
    // bob is a member of `conversationId` but does NOT emit join:conversation — he only has his
    // auto-joined user room. The fan-out must still reach him (the critical inbox-live fix).
    const sock = await connect(bob.token);
    try {
      const created = once(sock, "message:created");
      const sent = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: alice.token,
        body: { content: "inbox observer ping" },
      });
      expect(sent.status).toBe(201);
      const evt = await created;
      expect(evt.id).toBe(sent.body.id);
      expect(evt.content).toBe("inbox observer ping");
    } finally {
      sock.close();
    }
  });

  it("emits conversation:created to a new direct conversation's recipient", async () => {
    // A brand-new peer so the direct create is genuine (not get-or-create early-return).
    const dave = await createUser(projectId);
    const sock = await connect(dave.token); // auto-joins user:{proj}:dave
    try {
      const created = once(sock, "conversation:created");
      const res = await api("POST", `${base(projectId)}/chat/conversations/direct`, {
        token: alice.token,
        body: { userId: dave.id },
      });
      expect(res.status).toBe(201);
      const preview = await created;
      expect(preview.id).toBe(res.body.id);
      expect(preview.unreadCount).toBe(0);
      expect(preview.lastMessage ?? null).toBeNull();
      // dave's otherMembers = [alice]
      expect(preview.otherMembers.map((m: any) => m.id)).toEqual([alice.id]);
    } finally {
      sock.close();
    }
  });
```

This file already imports `createUser` (`chat-realtime.test.ts:13`).

- [ ] **Step 8: Run the realtime integration test**

Run (from `apps/api`): `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts chat-realtime`
Expected: PASS (original 4 + 2 new). (Requires `TEST_DATABASE_URL`.)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/test/integration/chat-realtime.test.ts
git commit -s -m "feat(chat): fan message:created to user rooms; emit conversation:created"
```

---

### Task 5: Connections realtime — route through the notification pipeline

**Suggested model:** standard (refactor across two files + realtime test).

**Files:**
- Modify: `apps/api/src/lib/notifications.ts` (add two public helpers near `notifyOnFollow`, line 319)
- Modify: `apps/api/src/routes/connections.ts` (remove local `notify()` lines 49-54; drop the now-unused `appNotifications` import; add the lib import; replace 3 call sites at lines 71, 77, 154)
- Test: `apps/api/test/integration/connections-realtime.test.ts`

**Interfaces:**
- Produces (in `lib/notifications.ts`):
  - `notifyOnConnectionRequest(projectId: string, recipientId: string, requesterId: string, connectionId: string): Promise<void>`
  - `notifyOnConnectionAccept(projectId: string, recipientId: string, accepterId: string, connectionId: string): Promise<void>`
- Consumes: the existing module-private `insert()` (`notifications.ts:50`) + `loadActor()` (`notifications.ts:39`), which already fire the webhook + `emitToUser(... "notification:created" ...)`.

**Note on a deliberate behavior change:** the old `connections.ts` `notify()` was awaited and could throw (propagating to the request). The new helpers follow the lib convention (`notifications.ts:12`) — they catch their own errors so a notification failure can never break the connection write. This matches every other `notifyOn*` helper and is intended.

- [ ] **Step 1: Add the two public helpers to `lib/notifications.ts`**

In `apps/api/src/lib/notifications.ts`, immediately after `notifyOnFollow` (ends line 328), add:

```ts
/** On a connection request: notify the addressee (connection-request). */
export async function notifyOnConnectionRequest(
  projectId: string, recipientId: string, requesterId: string, connectionId: string,
): Promise<void> {
  try {
    const actor = await loadActor(projectId, requesterId);
    if (!actor) return;
    await insert(projectId, recipientId, requesterId, "connection-request", "open-profile", { connectionId, ...actor });
  } catch (err) {
    logger.error("[notifications] notifyOnConnectionRequest failed");
    logger.debug({ err }, "[notifications] notifyOnConnectionRequest failed");
  }
}

/** On a connection accept: notify the original requester (connection-accepted). */
export async function notifyOnConnectionAccept(
  projectId: string, recipientId: string, accepterId: string, connectionId: string,
): Promise<void> {
  try {
    const actor = await loadActor(projectId, accepterId);
    if (!actor) return;
    await insert(projectId, recipientId, accepterId, "connection-accepted", "open-profile", { connectionId, ...actor });
  } catch (err) {
    logger.error("[notifications] notifyOnConnectionAccept failed");
    logger.debug({ err }, "[notifications] notifyOnConnectionAccept failed");
  }
}
```

(The metadata `{ connectionId, ...actor }` reproduces the old shape exactly — `loadActor` returns `{ initiatorId, initiatorName, initiatorUsername, initiatorAvatar }`.)

- [ ] **Step 2: Rewire `connections.ts`**

In `apps/api/src/routes/connections.ts`:

1. Remove the local `notify` function (lines 49-54 — the whole `async function notify(...) { … }`).
2. In the schema import line (line 11), remove `appNotifications` (now unused — TS `noUnusedLocals` would error). Change:
   ```ts
   import { connections, profiles, appNotifications } from "../db/schema/index.js";
   ```
   to:
   ```ts
   import { connections, profiles } from "../db/schema/index.js";
   ```
3. Add this import near the other lib imports (top of file):
   ```ts
   import { notifyOnConnectionRequest, notifyOnConnectionAccept } from "../lib/notifications.js";
   ```
4. Replace the call at line 71 (reopen-declined branch):
   ```ts
   await notify(self.projectId, target, "connection-request", self, row!.id);
   ```
   with:
   ```ts
   await notifyOnConnectionRequest(self.projectId, target, self.id, row!.id);
   ```
5. Replace the call at line 77 (fresh-insert branch):
   ```ts
   await notify(self.projectId, target, "connection-request", self, row!.id);
   ```
   with:
   ```ts
   await notifyOnConnectionRequest(self.projectId, target, self.id, row!.id);
   ```
6. Replace the call at line 154 (accept handler):
   ```ts
   await notify(self.projectId, row.requesterId, "connection-accepted", self, row.id);
   ```
   with:
   ```ts
   await notifyOnConnectionAccept(self.projectId, row.requesterId, self.id, row.id);
   ```

- [ ] **Step 3: Typecheck**

Run (repo root): `pnpm -r typecheck`
Expected: PASS (verifies `appNotifications` is no longer referenced and `ProfileRow`/`self` usages still compile).

- [ ] **Step 4: Write the realtime integration test**

```ts
// apps/api/test/integration/connections-realtime.test.ts
// Connection request/accept now route through lib/notifications.insert(), which fires
// notification:created to the recipient's user room (auto-joined on connect). Mirrors the
// chat-realtime harness: boots a real HTTP + socket.io server so a socket.io-client connects
// over the wire; REST writes fan out via the module-global io handle.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createApp } from "../../src/app.js";
import { attachRealtime } from "../../src/realtime/socket.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

let projectId: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachRealtime>;
let port: number;

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connectClient(`http://localhost:${port}`, {
      auth: { token }, query: { projectId }, transports: ["websocket"], reconnection: false,
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}
function once(socket: Socket, event: string, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload: unknown) => { clearTimeout(t); resolve(payload); });
  });
}

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
  bob = await createUser(projectId);
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { port = info.port; resolve(); });
  });
  io = attachRealtime(server as unknown as Parameters<typeof attachRealtime>[0]);
});
afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("connections realtime (socket.io e2e)", () => {
  it("delivers notification:created (connection-request) to the addressee's user room", async () => {
    const sock = await connect(bob.token); // auto-joins user:{proj}:bob
    try {
      const note = once(sock, "notification:created");
      const res = await api("POST", `${base(projectId)}/users/${bob.id}/connection`, {
        token: alice.token, body: {},
      });
      expect([200, 201]).toContain(res.status);
      const evt = await note;
      expect(evt.type).toBe("connection-request");
      expect(evt.metadata.initiatorId).toBe(alice.id);
    } finally {
      sock.close();
    }
  });

  it("delivers notification:created (connection-accepted) to the requester's user room", async () => {
    // alice (requester) listens; bob accepts.
    const sock = await connect(alice.token);
    try {
      // find the pending connection id from bob's side
      const pending = await api("GET", `${base(projectId)}/users/${alice.id}/connection`, { token: bob.token });
      const connId = pending.body.connectionId;
      const note = once(sock, "notification:created");
      const res = await api("PATCH", `${base(projectId)}/connections/${connId}/accept`, { token: bob.token });
      expect(res.status).toBe(200);
      const evt = await note;
      expect(evt.type).toBe("connection-accepted");
      expect(evt.metadata.initiatorId).toBe(bob.id);
    } finally {
      sock.close();
    }
  });
});
```

- [ ] **Step 5: Run the realtime integration test**

Run (from `apps/api`): `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts connections-realtime`
Expected: PASS (2 tests). (Requires `TEST_DATABASE_URL`.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/notifications.ts apps/api/src/routes/connections.ts apps/api/test/integration/connections-realtime.test.ts
git commit -s -m "feat(connections): fan request/accept notifications through the realtime pipeline"
```

---

### Task 6: Reconnect catch-up — `?after=` cursor on the messages endpoint

**Suggested model:** cheap (one handler branch + a test).

**Files:**
- Modify: `apps/api/src/routes/chat.ts` (`GET /conversations/:id/messages` handler, lines 246-279)
- Test: `apps/api/test/integration/chat-messages-after.test.ts`

**Interfaces:**
- Consumes: existing `Errors`, `asc`/`desc`, `chatMessages`.
- Produces: the messages handler accepts `?after=<ISO>` (filter `createdAt > after`, ascending order); rejects a malformed timestamp with `400 chat/invalid-after`.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/chat-messages-after.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("chat messages ?after= reconnect cursor (integration)", () => {
  let projectId: string; let B: string;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let convId: string;
  let ts1: string; // createdAt of the first message

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [alice, bob] = await Promise.all([createUser(projectId), createUser(projectId)]);
    const d = await api("POST", `${B}/chat/conversations/direct`, { token: alice.token, body: { userId: bob.id } });
    convId = d.body.id;
    const m1 = await api("POST", `${B}/chat/conversations/${convId}/messages`, { token: alice.token, body: { content: "first" } });
    ts1 = m1.body.createdAt;
    // ensure a strictly-later timestamp for the next two
    await new Promise((r) => setTimeout(r, 1100));
    await api("POST", `${B}/chat/conversations/${convId}/messages`, { token: alice.token, body: { content: "second" } });
    await api("POST", `${B}/chat/conversations/${convId}/messages`, { token: alice.token, body: { content: "third" } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("returns only messages created strictly after the cursor, in ascending order", async () => {
    const res = await api("GET", `${B}/chat/conversations/${convId}/messages?after=${encodeURIComponent(ts1)}&sort=asc&limit=100`, { token: bob.token });
    expect(res.status).toBe(200);
    const contents = res.body.messages.map((m: any) => m.content);
    expect(contents).toEqual(["second", "third"]); // "first" excluded (strictly after), ascending
  });

  it("rejects a malformed after timestamp with a clean 400 (not a Postgres 500)", async () => {
    const res = await api("GET", `${B}/chat/conversations/${convId}/messages?after=not-a-date`, { token: bob.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("chat/invalid-after");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/api`): `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts chat-messages-after`
Expected: FAIL — `after` is ignored (first test returns all three / wrong order) and the malformed case 500s.

- [ ] **Step 3: Add `?after=` support to the messages handler**

In `apps/api/src/routes/chat.ts`, in the `GET /conversations/:id/messages` handler:

Replace the order + cursor setup (lines 253-260):

```ts
    const order = c.req.query("sort") === "asc" ? asc(chatMessages.createdAt) : desc(chatMessages.createdAt);
    const parentId = c.req.query("parentId");
    const before = c.req.query("before"); // ISO timestamp cursor

    const conds = [eq(chatMessages.conversationId, convo.id)];
    // Main stream = top-level messages; thread view = replies to a specific parent.
    conds.push(parentId ? eq(chatMessages.parentMessageId, parentId) : sql`${chatMessages.parentMessageId} is null`);
    if (before) conds.push(sql`${chatMessages.createdAt} < ${before}::timestamptz`);
```

with:

```ts
    const parentId = c.req.query("parentId");
    const before = c.req.query("before"); // ISO timestamp cursor (back-pagination)
    const after = c.req.query("after");   // ISO timestamp cursor (reconnect catch-up — forward)
    if (after !== undefined && Number.isNaN(new Date(after).getTime())) {
      throw Errors.badRequest("chat/invalid-after", "after must be an ISO timestamp", "after");
    }
    // Reconnect catch-up reads forward (ascending) regardless of sort; back-pagination respects sort.
    const order = (after !== undefined || c.req.query("sort") === "asc") ? asc(chatMessages.createdAt) : desc(chatMessages.createdAt);

    const conds = [eq(chatMessages.conversationId, convo.id)];
    // Main stream = top-level messages; thread view = replies to a specific parent.
    conds.push(parentId ? eq(chatMessages.parentMessageId, parentId) : sql`${chatMessages.parentMessageId} is null`);
    if (before) conds.push(sql`${chatMessages.createdAt} < ${before}::timestamptz`);
    if (after !== undefined) conds.push(sql`${chatMessages.createdAt} > ${after}::timestamptz`);
```

(The rest of the handler — `removedFilter`, the select, `hasMore`, shaping — stays as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/api`): `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts chat-messages-after`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run (repo root): `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/test/integration/chat-messages-after.test.ts
git commit -s -m "feat(chat): support ?after= reconnect catch-up cursor on messages"
```

---

### Task 7: Keyset index migration

**Suggested model:** cheap (mechanical migration + journal edit).

**Files:**
- Create: `apps/api/drizzle/0054_conversations_keyset_idx.sql`
- Modify: `apps/api/drizzle/meta/_journal.json` (append the journal entry)

- [ ] **Step 1: Write the migration**

Create `apps/api/drizzle/0054_conversations_keyset_idx.sql`:

```sql
-- 0054_conversations_keyset_idx.sql
-- Keyset pagination index for the chat inbox. Matches GET /chat/conversations:
--   ORDER BY COALESCE(last_message_at, created_at) DESC, keyset on the same boundary.
-- created_at is NOT NULL, so the COALESCE result is never NULL (NULLS ordering is moot).
-- Idempotent.
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_keyset_idx"
  ON "conversations" ("project_id", (COALESCE("last_message_at", "created_at")) DESC, "created_at" DESC);
```

- [ ] **Step 2: Append the journal entry**

In `apps/api/drizzle/meta/_journal.json`, add this object as the **last** element of the `entries` array (after the `idx: 53`, `tag: "0053_events"` entry). `when` is the current journal max (`1781934611651`) + 1, keeping the watermark monotonic so the migrator runs it:

```json
		,{
			"idx": 54,
			"version": "7",
			"when": 1781934611652,
			"tag": "0054_conversations_keyset_idx",
			"breakpoints": true
		}
```

(Place the comma between the previous closing `}` and this new `{`. Ensure the final JSON is valid — this object is the last element, no trailing comma after it.)

- [ ] **Step 3: Apply + verify the migration**

Run (from `apps/api`):

```bash
pnpm db:migrate:run
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$url" -c "\d+ conversations" | grep conversations_keyset_idx
```

Expected: `db:migrate:run` reports applying `0054_conversations_keyset_idx`; `\d+` lists the new index. Re-running `pnpm db:migrate:run` is a no-op (idempotent), confirming it doesn't re-apply.

- [ ] **Step 4: Commit**

```bash
git add apps/api/drizzle/0054_conversations_keyset_idx.sql apps/api/drizzle/meta/_journal.json
git commit -s -m "feat(db): keyset index for chat inbox pagination"
```

---

### Task 8: Changelog + final verification

**Suggested model:** cheap (docs + run the suites).

**Files:**
- Modify: `CHANGELOG.md` (repo root, `## [Unreleased]`)

- [ ] **Step 1: Add changelog entries**

Read `CHANGELOG.md` first (so the Edit matches). Under `## [Unreleased]`, add (merging into existing `Added`/`Changed`/`Fixed` subsections if present):

```markdown
### Added
- Chat: `GET /chat/conversations/:id/preview` (single `ConversationPreview` — `unreadCount`, `otherMembers`, truncated `lastMessage`).
- Chat: `conversation:created` socket event fanned to member user rooms on new direct/group conversations.
- Chat: `?after=<ISO>` cursor on `GET /chat/conversations/:id/messages` for reconnect catch-up (ascending, strictly after the cursor; `400 chat/invalid-after` on a malformed timestamp).
- DB: `conversations_keyset_idx` for inbox keyset pagination.

### Changed
- Chat: `GET /chat/conversations` now returns the `ConversationPreview` shape (`otherMembers`, `lastMessage` truncated to 100 chars).
- Connections: request/accept notifications now route through the shared notification pipeline, so they fan out over `notification:created` (realtime) and the push webhook — previously inserted silently.

### Fixed
- Chat: `message:created` now fans out to every member's user room (inbox observers update without joining the thread room), not only the conversation room.
```

- [ ] **Step 2: Full verification**

Run (from repo root):

```bash
pnpm -r build && pnpm -r typecheck && pnpm --filter @agora/api test
```

Expected: build, typecheck, and the unit suite all PASS.

Then the touched integration suites (from `apps/api`, requires `TEST_DATABASE_URL`):

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts chat-preview chat-realtime connections-realtime chat-messages-after
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -s -m "docs(changelog): live inbox + realtime connections"
```

---

## Self-Review

**Spec coverage (against `2026-06-29-live-inbox-unified-design.md`):**
- §3.1 preview shapers → Task 1 ✅
- §3.2 socket fan-out helpers + `conversation:created` event → Task 2 ✅
- §3.3 `buildConversationPreview` / `/preview` / list shape switch → Task 3; message fan-out + `emitConversationCreated` + create-handler wiring → Task 4; `?after=` cursor → Task 6 ✅
- §3.4 connections realtime wiring → Task 5 ✅
- §3.5 keyset index migration → Task 7 ✅
- §3.6 reconnect/room-rejoin → no server work (stateless, client re-emits `join:conversation`); confirmed by Task 4's inbox-observer test (user room auto-join carries the inbox with no explicit join) ✅
- §5 testing: unit (Task 1, 2) + integration (Task 3, 4, 5, 6) ✅
- §2.1 non-goals respected: `otherMembers` NOT added to `GET /:id` detail (Task 3 only touches list + `/preview`); no dedicated connection socket events (Task 5 reuses `notification:created`) ✅

**Placeholder scan:** none — every code/step block is concrete.

**Type consistency:** `buildConversationPreview(c, convo, member)`, `emitConversationCreated(c, convo, memberIds)`, `emitMessageCreated(conversationId, projectId, memberUserIds, message)`, `messageCreatedRooms(conversationId, projectId, memberUserIds)`, `shapeConversationPreview(row, opts)`, `pickOtherMembers(rows, max?)`, `truncateMessageContent(msg, max?)`, `notifyOnConnectionRequest/Accept(projectId, recipientId, actorId, connectionId)` — names/signatures are used identically across tasks. `ConversationRow`/`MemberRow` are the existing aliases in `chat.ts:26-27`.

**Migration numbering:** `0054` / `when 1781934611652` (strictly > the current journal max `1781934611651` from `0053_events`) — corrects the stale `0053`/`1781934611650` figures in the original draft spec.
