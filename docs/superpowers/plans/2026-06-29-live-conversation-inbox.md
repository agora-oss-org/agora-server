# Live Conversation Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat inbox live and complete — fan `message:created` out to every member's user room (the critical bug), add the `/preview` endpoint and a `ConversationPreview` shaper (`unreadCount` + truncated `lastMessage` + `otherMembers`), emit `conversation:created` on new conversations, and add a keyset index.

**Architecture:** Pure shaping/truncation/room-name helpers are unit-tested without a DB; the chat route gets one shared `buildConversationPreview` helper used by the list endpoint, the new preview endpoint, and (in a zero-state form) the `conversation:created` emit. The socket layer gets a single fan-out helper that unions the conversation room with member user rooms.

**Tech Stack:** Hono, socket.io (+ optional Redis adapter), Drizzle ORM, vitest (unit, no DB), Postgres (the keyset index migration).

## Global Constraints

- Pure/branching logic ships with unit tests in the same change (`src/**/*.test.ts`, vitest, no DB).
- DB-backed behavior is covered by the existing chat e2e path; new pure helpers get unit tests.
- Use the shared `logger`; `info`/`error` message-only, raw detail on `debug`. Pino arg order: `logger.debug({ err }, "msg")`.
- Socket event names are contract — must stay byte-identical to the SDK (`@replyke/core/types/socket.ts`). `conversation:created` is the exact event name.
- Migrations: apply with `pnpm db:migrate:run` (NOT `db:migrate`). New custom SQL is idempotent (`CREATE INDEX IF NOT EXISTS`). The journal `when` must be strictly greater than the current max (`1781934611650`).
- `pnpm -r typecheck` and `pnpm --filter @agora/api test` must pass before any task is done.
- Run vitest from `apps/api`: `pnpm test -- <pattern>`.

---

### Task 1: Pure preview shapers (truncation, otherMembers, ConversationPreview)

**Files:**
- Modify: `apps/api/src/lib/shape.ts` (add helpers near the chat shapers, ~line 490-519)
- Test: `apps/api/src/lib/shape-preview.test.ts`

**Interfaces:**
- Produces:
  - `truncateMessageContent<T extends { content?: unknown }>(msg: T, max?: number): T` — codepoint-safe truncation of a shaped message's `content` (default max 100).
  - `pickOtherMembers(rows: Array<{ id: string; name: string | null; username: string | null; avatar: string | null }>, max?: number): Array<{ id: string; name: string | null; username: string | null; avatar: string | null }>` — caps to `max` (default 5) and projects the 4 inbox fields.
  - `shapeConversationPreview(row, opts: { unreadCount: number; lastMessage: Record<string, unknown> | null; otherMembers: Array<{ id; name; username; avatar }>; currentMember?: unknown })` — base conversation + `unreadCount` + truncated `lastMessage` + `otherMembers`.

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

In `apps/api/src/lib/shape.ts`, immediately after `shapeConversation` (ends line 519), add:

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
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/shape.ts apps/api/src/lib/shape-preview.test.ts
git commit -m "feat(shape): add ConversationPreview shaper + truncation/otherMembers helpers"
```

---

### Task 2: Socket fan-out helper + `conversation:created` event

**Files:**
- Modify: `apps/api/src/realtime/socket.ts` (ServerToClientEvents ~line 31-34; exports ~line 177-196)
- Test: `apps/api/src/realtime/socket.test.ts`

**Interfaces:**
- Produces:
  - `messageCreatedRooms(conversationId: string, projectId: string, memberUserIds: string[]): string[]` — `["conversation:{id}", "user:{proj}:{u}", …]`.
  - `emitMessageCreated(conversationId: string, projectId: string, memberUserIds: string[], message: unknown): void` — emits `message:created` to the union of those rooms (one delivery per socket; no-op when `ioRef` is null).
  - `"conversation:created"` added to `ServerToClientEvents`.

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

In `apps/api/src/realtime/socket.ts`, add `conversation:created` to the `ServerToClientEvents`
interface (after the `conversation:deleted` line, ~line 32):

```ts
  "conversation:created": (preview: unknown) => void;
```

Then, after the `emitToUser` function (ends ~line 196), add:

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
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/realtime/socket.ts apps/api/src/realtime/socket.test.ts
git commit -m "feat(socket): add message:created fan-out helper + conversation:created event"
```

---

### Task 3: Shared `buildConversationPreview` + `/preview` endpoint + list uses the preview shape

**Files:**
- Modify: `apps/api/src/routes/chat.ts` (imports line 4-22; list handler line 62-101; add a helper + the preview route)

**Interfaces:**
- Consumes: `shapeConversationPreview`, `pickOtherMembers` (Task 1); existing `shapeChatMessage`, `shapeConversationMember`, `shapeUser`.
- Produces: `buildConversationPreview(c, convo, member)` (module-private async helper) → a shaped `ConversationPreview`.

- [ ] **Step 1: Extend the drizzle + shape imports**

In `apps/api/src/routes/chat.ts`:
- Add `ne` to the `drizzle-orm` import (line 4): `import { and, eq, desc, asc, count, inArray, gt, ne, sql } from "drizzle-orm";`
- Add the new shapers to the `../lib/shape.js` import (line 13): add `shapeConversationPreview, pickOtherMembers`.

- [ ] **Step 2: Add the shared helper**

Add this module-private helper near the top of the file (e.g. after `userReactionsByMessage`, ~line 58):

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

In the GET `/conversations` handler, replace the `const data = await Promise.all(...)` block
(currently lines 90-100) with:

```ts
    const data = await Promise.all(rows.slice(0, limit).map(({ convo, member }) => buildConversationPreview(c, convo, member)));
```

- [ ] **Step 4: Add the preview endpoint (ABOVE `/conversations/:id`)**

Insert this route immediately after the `/conversations/unread-count` handler (ends line 158) and
BEFORE `.get("/conversations/:id", …)` (line 159), so Hono doesn't capture `preview` as an `:id`:

```ts
  .get("/conversations/:id/preview", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    return c.json(await buildConversationPreview(c, convo, member));
  })
```

- [ ] **Step 5: Typecheck**

Run (from repo root): `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Manual verification (dev server)**

```bash
P=11111111-1111-1111-1111-111111111111
TOK=...   # a valid access token (see CLAUDE.md "Mint a test JWT")
# list now carries otherMembers + (≤100-char) lastMessage:
curl -s -H "Authorization: Bearer $TOK" "http://localhost:4000/v7/$P/chat/conversations?limit=5" | head -c 400
# single preview:
curl -s -H "Authorization: Bearer $TOK" "http://localhost:4000/v7/$P/chat/conversations/<CONV_UUID>/preview" | head -c 400
```

Expected: each conversation/preview JSON includes `unreadCount`, `otherMembers` (array; empty for
space chats), and `lastMessage` (or null). The `/preview` path returns 200, not a `:id` 500.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/chat.ts
git commit -m "feat(chat): ConversationPreview list + /preview endpoint"
```

---

### Task 4: Fan `message:created` to user rooms; emit `conversation:created`

**Files:**
- Modify: `apps/api/src/routes/chat.ts` (message-create handler line 280-332; create handlers line 103-141; import line 20)

**Interfaces:**
- Consumes: `emitMessageCreated`, `emitToUser` (Task 2 / existing socket exports); `buildConversationPreview` not used here (creation is zero-state).

- [ ] **Step 1: Extend the socket import**

Change the socket import (line 20) from:

```ts
import { emitToConversation } from "../realtime/socket.js";
```

to:

```ts
import { emitToConversation, emitToUser, emitMessageCreated } from "../realtime/socket.js";
```

- [ ] **Step 2: Fan `message:created` to all members' user rooms**

In the POST `/conversations/:id/messages` handler, replace the single line (line 325):

```ts
    emitToConversation(convo.id, "message:created", shaped);
```

with a member lookup + the union fan-out:

```ts
    const memberRows = await db.select({ userId: conversationMembers.userId }).from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.isActive, true)));
    emitMessageCreated(convo.id, c.var.projectId, memberRows.map((m) => m.userId), shaped);
```

- [ ] **Step 3: Add a `conversation:created` emitter helper**

Add this module-private helper near `buildConversationPreview` in `chat.ts`:

```ts
// Notify each member's inbox of a new conversation. Zero-state preview (unreadCount 0, no lastMessage);
// otherMembers is the rest of the roster (excluding the recipient). Skipped for space chats.
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

- [ ] **Step 4: Call it from the group + direct create handlers**

In POST `/conversations` (group), after the `logger.info(...)` line (line 116) and before the
`return c.json(...)` (line 117), add:

```ts
    await emitConversationCreated(c, convo!, memberIds);
```

In POST `/conversations/direct`, in the branch that creates a NEW conversation (after the
`db.insert(conversationMembers).values([...])` at line 136-139, before `return c.json(...)` line 140), add:

```ts
    await emitConversationCreated(c, convo!, [uid, other]);
```

- [ ] **Step 5: Typecheck**

Run (from repo root): `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Manual verification (two clients)**

With two browser/SDK sessions in the same project: user A (inbox open, thread NOT opened) should see
a new conversation appear when user B starts a direct chat with A (`conversation:created`), and should
see the inbox row reorder + unread bump when B sends a message (`message:created` via the user room) —
all without A joining the conversation room. (The repo's `apps/api/scripts/chat-e2e.mjs` is the
reference harness for socket assertions.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/chat.ts
git commit -m "feat(chat): fan message:created to user rooms; emit conversation:created"
```

---

### Task 5: Keyset index migration

**Files:**
- Create: `apps/api/drizzle/0053_conversations_keyset_idx.sql`
- Modify: `apps/api/drizzle/meta/_journal.json` (append the journal entry)

- [ ] **Step 1: Write the migration**

```sql
-- apps/api/drizzle/0053_conversations_keyset_idx.sql
-- Keyset pagination index for the chat inbox. Matches GET /chat/conversations:
--   ORDER BY COALESCE(last_message_at, created_at) DESC, keyset on the same boundary.
-- Idempotent.
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_keyset_idx"
  ON "conversations" ("project_id", (COALESCE("last_message_at", "created_at")) DESC, "created_at" DESC);
```

- [ ] **Step 2: Append the journal entry**

In `apps/api/drizzle/meta/_journal.json`, add this object to the end of the `entries` array (after the
`idx: 52` entry). The `when` is the current max (`1781934611650`) + 1, keeping it monotonic so the
migrator's watermark gate runs it:

```json
		,{
			"idx": 53,
			"version": "7",
			"when": 1781934611651,
			"tag": "0053_conversations_keyset_idx",
			"breakpoints": true
		}
```

(Place the comma correctly — it goes between the previous closing `}` and this new `{`. Ensure the
final JSON is valid: the new object is the last element, no trailing comma after it.)

- [ ] **Step 3: Apply + verify the migration**

Run (from `apps/api`):

```bash
pnpm db:migrate:run
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$url" -c "\d+ conversations" | grep conversations_keyset_idx
```

Expected: `db:migrate:run` reports applying `0053_conversations_keyset_idx`; `\d+` lists the new index.
Re-running `pnpm db:migrate:run` is a no-op (idempotent), confirming it doesn't re-apply.

- [ ] **Step 4: Commit**

```bash
git add apps/api/drizzle/0053_conversations_keyset_idx.sql apps/api/drizzle/meta/_journal.json
git commit -m "feat(db): keyset index for chat inbox pagination"
```

---

### Task 6: Changelog + final verification

**Files:**
- Modify: `CHANGELOG.md` (repo root, `## [Unreleased]`)

- [ ] **Step 1: Add changelog entries**

Under `## [Unreleased]`:

```markdown
### Added
- Chat: `GET /chat/conversations/:id/preview` (single `ConversationPreview`).
- Chat: `conversation:created` socket event to member user rooms on new direct/group conversations.
- DB: `conversations_keyset_idx` for inbox keyset pagination.

### Changed
- Chat: `GET /chat/conversations` now returns the `ConversationPreview` shape (`otherMembers`, `lastMessage` truncated to 100 chars).

### Fixed
- Chat: `message:created` now fans out to every member's user room (inbox observers update without joining the thread room), not only the conversation room.
```

- [ ] **Step 2: Full verification**

Run (from repo root):

```bash
pnpm -r build && pnpm -r typecheck && pnpm --filter @agora/api test
```

Expected: build, typecheck, and the unit suite all PASS.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): live conversation inbox"
```

---

## Self-Review notes

- **Spec coverage:** message:created → user rooms (Task 2 helper + Task 4 wiring); `/preview` (Task 3); `shapeConversationPreview` with truncation + otherMembers (Task 1, applied in Task 3/4); `conversation:created` always carrying `unreadCount`/`otherMembers` (Task 2 event + Task 4 emit, zero-state `unreadCount: 0`); keyset index (Task 5). All covered.
- **Reconnect:** server stays stateless; client re-emits `join:conversation` (no server work — confirmed in spec). Nothing to build.
- **Route ordering:** `/preview` is inserted above `/conversations/:id` (Task 3 Step 4) and `/unread-count` already precedes `:id`.
- **Type consistency:** `buildConversationPreview`, `emitConversationCreated`, `emitMessageCreated`, `messageCreatedRooms`, `shapeConversationPreview`, `pickOtherMembers`, `truncateMessageContent` names are used identically across tasks. `ConversationRow`/`MemberRow` are the existing type aliases in `chat.ts` (lines 26-27).
- **Index vs query:** the index expression matches the list query's `COALESCE(last_message_at, created_at) DESC` exactly (Task 5). `created_at` is NOT NULL so NULLS ordering is moot.
