# Space-reputation Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a space-scoped `spaceReputation` on returned/embedded users when the SDK asks for it (`spaceReputationId` uuid/none, `spaceReputationDescendants`), by connecting the existing `loadSpaceReputations` engine to the response shapers via a centralized post-shape enrichment pass.

**Architecture:** A per-router middleware (`spaceRepGate`) parses + validates the query params (throwing the contract 400s) and stashes a resolved directive on the request context. Covered handlers wrap their return in `enrichSpaceReputation(c, payload)`, which recursively collects every embedded full `User` in the payload, batch-loads reputations once, and stamps `spaceReputation` on each. Shapers and `loadUsers` are unchanged, so absent-param responses stay byte-identical.

**Tech Stack:** TypeScript, Hono, Drizzle/postgres.js, zod, vitest (unit + real-Postgres integration). pnpm workspaces (contract → core → api).

## Global Constraints

- **Value modes this phase:** `<uuid>` (with optional descendant rollup) and `"none"` (alias global `profiles.reputation`). `"context"` validates OK on context routes but **emits nothing** (deferred); `"context"` on a user-direct route → `400`. Absent param → no field (unchanged).
- **Endpoint classes (from `validateSpaceReputationParams`):** context = `uuid|none|context`; user-direct = `uuid|none` (`context` → 400).
- **Coverage — match the SDK's list exactly.** Context class: `entities`, `comments`, reaction listings, `chat`, `spaces` (team/members), `search`, `reports`, `follows`, `connections`. User-direct class: `users`. **Out of scope (do NOT mount):** `events`, `steward`, `admin`, `roles`, `collections`, `misc`, `social`, `push-notifications`, `match`, `db`, `auth`, `storage`, `app-notifications`.
- **Additive-only mutation:** the enrichment pass writes nothing but `spaceReputation`, and runs only when the directive is non-null (caller opted in).
- **No new migration.** The `space_reputation` table (migrations `0058`/`0059`) and the `loadSpaceReputations` engine already exist and are unit-tested. This feature only reads them.
- **Security/logging:** `info`/`error` are message-only; the `context`-deferred note and any skip go on `logger.debug`. Parameterize SQL (the engine already does). Server is the trust boundary.
- **Definition of done:** `pnpm -r typecheck` and `pnpm test` pass; the new integration tests pass under `pnpm test:integration`.

## File Structure

- `packages/contract/src/types.ts` — add `spaceReputation?: number` to `User`; add the `SpaceReputationDirective` type. (Rebuilt to `dist/` and consumed by core + api.)
- `packages/core/src/http/context.ts` — add `spaceRep?: SpaceReputationDirective | null` to `Variables`.
- `apps/api/src/lib/space-reputation-enrich.ts` — NEW. The pure core (`collectUsers`, `resolveDirective`, `stampReputations`) + the async orchestrator `enrichSpaceReputation`.
- `apps/api/src/lib/space-reputation-enrich.test.ts` — NEW. Unit tests for the pure core.
- `apps/api/src/middleware/space-rep.ts` — NEW. `spaceRepGate(endpointClass)`.
- `apps/api/src/routes/{users,entities,comments,chat,spaces,search,reports,follows,connections}.ts` — mount the gate + wrap user-embedding returns.
- `apps/api/test/integration/space-reputation.test.ts` — NEW. Real-Postgres coverage per endpoint class + descendants.
- `CHANGELOG.md`, `docs/MANIFEST.md`, `docs/MODELS.md` — document the param + coverage; drop scaffold language.

---

### Task 1: Contract field + directive type + pure enrichment core

**Files:**
- Modify: `packages/contract/src/types.ts` (add `spaceReputation?` to `User`, ~line 19; add `SpaceReputationDirective`)
- Modify: `packages/core/src/http/context.ts` (add `spaceRep?` to `Variables` — needed for `enrichSpaceReputation` to typecheck)
- Create: `apps/api/src/lib/space-reputation-enrich.ts`
- Test: `apps/api/src/lib/space-reputation-enrich.test.ts`

**Interfaces:**
- Consumes: `validateSpaceReputationParams(raw, endpointClass)` and `loadSpaceReputations(projectId, spaceId, includeDescendants, userIds)` from `./space-reputation.js` (already exist).
- Produces:
  - `type SpaceReputationDirective = { mode: "global" } | { mode: "space"; spaceId: string; includeDescendants: boolean }` (exported from `@agora-server/contract`).
  - `collectUsers(payload: unknown): UserLike[]` — every full-`User` object in the payload (all occurrences, not deduped).
  - `resolveDirective(raw: { spaceReputationId?: string; spaceReputationDescendants?: string }, endpointClass: "context" | "user-direct"): SpaceReputationDirective | null` — validates (throws) then maps; `undefined`/`"context"` → `null`.
  - `stampReputations(users: UserLike[], directive: SpaceReputationDirective, map: Map<string, number> | null): void`.
  - `enrichSpaceReputation<T>(c: Context<{ Variables: Variables }>, payload: T, projectId?: string): Promise<T>`.

- [ ] **Step 1: Add the contract type + field**

In `packages/contract/src/types.ts`, add to the `User` interface (after `reputation: number;`):
```ts
  reputation: number;
  spaceReputation?: number; // space-scoped reputation, attached when the SDK requests it (v7.8.2 #6)
  createdAt: string;
```
And add the directive type (near the top-level type exports):
```ts
// The resolved space-reputation request directive (from spaceReputationId/spaceReputationDescendants).
// null (not represented here) means "no enrichment"; the mode discriminates global vs a specific space.
export type SpaceReputationDirective =
  | { mode: "global" }
  | { mode: "space"; spaceId: string; includeDescendants: boolean };
```

- [ ] **Step 2: Build the contract**

Run: `pnpm --filter @agora-server/contract build`
Expected: builds clean (dist updated).

- [ ] **Step 3: Add the context variable + rebuild core**

In `packages/core/src/http/context.ts` (so `enrichSpaceReputation` can read the directive):
```ts
import type { AuthContext, SpaceReputationDirective } from "@agora-server/contract";
export type { AuthContext };

export type Variables = {
  projectId: string;
  auth: AuthContext | null;   // null when route is unauthenticated / token absent
  spaceRep?: SpaceReputationDirective | null; // resolved space-reputation directive (v7.8.2 #6)
};
```
Run: `pnpm --filter @agora/core build`
Expected: builds clean.

- [ ] **Step 4: Write the failing unit test**

Create `apps/api/src/lib/space-reputation-enrich.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { collectUsers, resolveDirective, stampReputations } from "./space-reputation-enrich.js";

const UUID = "11111111-1111-1111-1111-111111111111";
const user = (id: string, reputation = 3) => ({
  id, projectId: "p", foreignId: null, role: "visitor", name: null, username: "u_" + id,
  avatar: null, avatarFileId: null, bannerFileId: null, bio: null, birthdate: null,
  location: null, metadata: {}, reputation, createdAt: "2026-01-01T00:00:00.000Z",
});

describe("collectUsers", () => {
  it("finds top-level, nested, and array-embedded users", () => {
    const payload = {
      data: [{ id: "e1", user: user("a"), topComment: { id: "c1", user: user("b") } }],
      pagination: {},
    };
    const ids = collectUsers(payload).map((u) => u.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });
  it("returns EVERY occurrence (same id embedded twice → two objects), for uniform stamping", () => {
    const shared = () => user("a");
    const found = collectUsers([{ user: shared() }, { user: shared() }]);
    expect(found).toHaveLength(2);
  });
  it("ignores Entity/Comment/Space and the reduced userSummary shape", () => {
    const entity = { id: "e", shortId: "s", reactionCounts: {}, createdAt: "x" }; // no role/username
    const summary = { id: "z", username: "z", name: "Z", reputation: 1 };          // no role/createdAt
    expect(collectUsers({ entity, summary })).toEqual([]);
  });
  it("does not infinite-loop on a cyclic object", () => {
    const o: any = { user: user("a") }; o.self = o;
    expect(collectUsers(o).map((u) => u.id)).toEqual(["a"]);
  });
});

describe("resolveDirective", () => {
  it("absent → null", () => {
    expect(resolveDirective({}, "context")).toBeNull();
  });
  it("'none' → global", () => {
    expect(resolveDirective({ spaceReputationId: "none" }, "context")).toEqual({ mode: "global" });
  });
  it("uuid → space (descendants from the flag)", () => {
    expect(resolveDirective({ spaceReputationId: UUID, spaceReputationDescendants: "true" }, "context"))
      .toEqual({ mode: "space", spaceId: UUID, includeDescendants: true });
    expect(resolveDirective({ spaceReputationId: UUID }, "context"))
      .toEqual({ mode: "space", spaceId: UUID, includeDescendants: false });
  });
  it("'context' on a context route → null (deferred, no throw)", () => {
    expect(resolveDirective({ spaceReputationId: "context" }, "context")).toBeNull();
  });
  it("'context' on a user-direct route → throws (400)", () => {
    expect(() => resolveDirective({ spaceReputationId: "context" }, "user-direct")).toThrow();
  });
  it("garbage id → throws", () => {
    expect(() => resolveDirective({ spaceReputationId: "garbage" }, "context")).toThrow();
  });
});

describe("stampReputations", () => {
  it("global mode copies each user's own reputation", () => {
    const users = [user("a", 7), user("b", 2)];
    stampReputations(users, { mode: "global" }, null);
    expect(users.map((u) => u.spaceReputation)).toEqual([7, 2]);
  });
  it("space mode reads the map, defaulting a missing id to 0", () => {
    const users = [user("a"), user("b")];
    stampReputations(users, { mode: "space", spaceId: UUID, includeDescendants: false }, new Map([["a", 9]]));
    expect(users.map((u) => u.spaceReputation)).toEqual([9, 0]);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @agora/api test -- space-reputation-enrich`
Expected: FAIL — `space-reputation-enrich.js` does not exist.

- [ ] **Step 6: Implement the enrichment lib**

Create `apps/api/src/lib/space-reputation-enrich.ts`:
```ts
// Centralized post-shape space-reputation enrichment (v7.8.2 #6). A directive is resolved+stashed by
// middleware/space-rep.ts; covered handlers call enrichSpaceReputation on their payload before c.json.
// This phase implements the `uuid` and `"none"` modes; `"context"` resolves to null (deferred).
import type { Context } from "hono";
import type { User, SpaceReputationDirective } from "@agora-server/contract";
import type { Variables } from "../http/context.js";
import { loadSpaceReputations, validateSpaceReputationParams } from "./space-reputation.js";

type UserLike = User & Record<string, unknown>;

// A full User is uniquely identified by carrying all of these keys. Entity/Comment/Space lack
// role+username+reputation; the reduced moderation userSummary lacks role+createdAt.
function isUserShape(o: Record<string, unknown>): boolean {
  return "id" in o && "role" in o && "username" in o && "reputation" in o && "createdAt" in o;
}

/** Every full-User object in the payload — ALL occurrences (a repeated author yields one object per
 *  embed, so each gets stamped). Cycle-safe via object-identity tracking. Pure. */
export function collectUsers(payload: unknown): UserLike[] {
  const users: UserLike[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    const o = v as Record<string, unknown>;
    if (isUserShape(o)) users.push(o as UserLike);
    for (const k in o) walk(o[k]);
  };
  walk(payload);
  return users;
}

/** Validate (throws the contract 400s) then map the raw params to a directive. absent/"context" → null. */
export function resolveDirective(
  raw: { spaceReputationId?: string; spaceReputationDescendants?: string },
  endpointClass: "context" | "user-direct",
): SpaceReputationDirective | null {
  validateSpaceReputationParams(raw, endpointClass);
  const id = raw.spaceReputationId;
  if (id === undefined || id === "context") return null; // absent OR deferred context → no enrichment
  if (id === "none") return { mode: "global" };
  return { mode: "space", spaceId: id, includeDescendants: raw.spaceReputationDescendants === "true" };
}

/** Assign spaceReputation on each user: global → own reputation; space → map (missing → 0). Pure. */
export function stampReputations(
  users: UserLike[],
  directive: SpaceReputationDirective,
  map: Map<string, number> | null,
): void {
  for (const u of users) {
    u.spaceReputation = directive.mode === "global" ? u.reputation : (map?.get(u.id) ?? 0);
  }
}

/** Post-shape enrichment. No-op unless a directive is stashed. `projectId` overrides c.var.projectId
 *  for root-mounted routers (connections derives it from the authed profile). Returns the same payload. */
export async function enrichSpaceReputation<T>(
  c: Context<{ Variables: Variables }>,
  payload: T,
  projectId?: string,
): Promise<T> {
  const directive = c.get("spaceRep") ?? null;
  if (!directive) return payload;
  const users = collectUsers(payload);
  if (users.length === 0) return payload;
  if (directive.mode === "global") {
    stampReputations(users, directive, null);
    return payload;
  }
  const pid = projectId ?? c.get("projectId");
  if (!pid) return payload;
  const ids = [...new Set(users.map((u) => u.id))];
  const map = await loadSpaceReputations(pid, directive.spaceId, directive.includeDescendants, ids);
  stampReputations(users, directive, map);
  return payload;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @agora/api test -- space-reputation-enrich`
Expected: PASS (all describe blocks green).

- [ ] **Step 8: Typecheck**

Run: `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/contract/src/types.ts packages/core/src/http/context.ts apps/api/src/lib/space-reputation-enrich.ts apps/api/src/lib/space-reputation-enrich.test.ts
git commit -m "feat(space-rep): contract field + Variables + pure enrichment core (collect/resolve/stamp)"
```

---

### Task 2: Middleware + wire the `users` router (user-direct vertical slice)

**Files:**
- Create: `apps/api/src/middleware/space-rep.ts`
- Modify: `apps/api/src/routes/users.ts` (mount gate; remove `checkSpaceRep`; wrap user-embedding returns)
- Test: `apps/api/test/integration/space-reputation.test.ts`

**Interfaces:**
- Consumes: `resolveDirective`, `enrichSpaceReputation` (Task 1); the `spaceRep` context variable + `SpaceReputationDirective` (Task 1).
- Produces: `spaceRepGate(endpointClass: "context" | "user-direct"): MiddlewareHandler` (sets `c.set("spaceRep", …)`).

- [ ] **Step 1: Write the middleware**

Create `apps/api/src/middleware/space-rep.ts`:
```ts
// Parses + validates the space-reputation query params for a router and stashes the resolved directive.
// Mounted per-router with the router's endpoint class; validation (400s) can't be forgotten on a
// mounted route. The enrichment itself happens in each handler via enrichSpaceReputation.
import type { MiddlewareHandler } from "hono";
import type { Variables } from "../http/context.js";
import { resolveDirective } from "../lib/space-reputation-enrich.js";
import { logger } from "../lib/logger.js";

export function spaceRepGate(endpointClass: "context" | "user-direct"): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    const directive = resolveDirective(
      {
        spaceReputationId: c.req.query("spaceReputationId"),
        spaceReputationDescendants: c.req.query("spaceReputationDescendants"),
      },
      endpointClass,
    );
    if (c.req.query("spaceReputationId") === "context") {
      logger.debug("space-reputation 'context' mode requested but deferred; emitting nothing");
    }
    c.set("spaceRep", directive);
    await next();
  };
}
```

- [ ] **Step 2: Wire `users.ts`**

In `apps/api/src/routes/users.ts`:
1. Remove the `checkSpaceRep` const (lines ~21-27) and its per-handler calls, and the `validateSpaceReputationParams` import.
2. Import the gate + enrich helper:
```ts
import { spaceRepGate } from "../middleware/space-rep.js";
import { enrichSpaceReputation } from "../lib/space-reputation-enrich.js";
```
3. Mount the gate as the first link in the chain:
```ts
export const userRoutes = new Hono<{ Variables: Variables }>()
  .use("*", spaceRepGate("user-direct"))
  .get("/by-foreign-id", async (c) => {
```
4. Wrap each user-embedding return with `enrichSpaceReputation(c, …)`. The exact sites (by current line):
   - `44` `return c.json(await enrichSpaceReputation(c, shapeUser(row)));`
   - `51` same transform
   - `74` `return c.json(await enrichSpaceReputation(c, rows.map(shapeUser)));`
   - `80` same as 44
   - `114` `return c.json(await enrichSpaceReputation(c, shaped));`
   - `163` `return c.json(await enrichSpaceReputation(c, await followList(c.var.projectId, "followers", c.req.param("id"), page, limit, offset)));`
   - `168` same for `"following"`
   Leave non-user payloads untouched (check-username, isFollowing, follow mutations, counts, suspensions).

- [ ] **Step 3: Write the failing integration test**

Create `apps/api/test/integration/space-reputation.test.ts`:
```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { spaces, spaceReputation } from "../../src/db/schema/index.js";

const projects: string[] = [];
afterAll(async () => { for (const p of projects) await deleteProject(p); });

async function seedSpace(projectId: string, ownerId: string): Promise<string> {
  const [s] = await getDb().insert(spaces).values({
    projectId, shortId: `sr_${randomUUID().slice(0, 8)}`, name: "rep-space", userId: ownerId,
  }).returning();
  return s!.id;
}
async function setRep(projectId: string, spaceId: string, userId: string, reputation: number) {
  await getDb().insert(spaceReputation).values({ projectId, spaceId, userId, reputation });
}

describe("space-reputation enrichment — user-direct", () => {
  it("uuid attaches the space-scoped number; absent omits the field", async () => {
    const pid = await createProject(); projects.push(pid);
    const owner = await createUser(pid);
    const spaceId = await seedSpace(pid, owner.id);
    await setRep(pid, spaceId, owner.id, 42);

    const plain = await api("GET", `${base(pid)}/users/${owner.id}`, { token: owner.token });
    expect(plain.status).toBe(200);
    expect(plain.body.spaceReputation).toBeUndefined();

    const enriched = await api("GET", `${base(pid)}/users/${owner.id}?spaceReputationId=${spaceId}`, { token: owner.token });
    expect(enriched.body.spaceReputation).toBe(42);
  });

  it("'none' mirrors global reputation", async () => {
    const pid = await createProject(); projects.push(pid);
    const u = await createUser(pid);
    const r = await api("GET", `${base(pid)}/users/${u.id}?spaceReputationId=none`, { token: u.token });
    expect(r.body.spaceReputation).toBe(r.body.reputation);
  });

  it("'context' → 400 on a user-direct route", async () => {
    const pid = await createProject(); projects.push(pid);
    const u = await createUser(pid);
    const r = await api("GET", `${base(pid)}/users/${u.id}?spaceReputationId=context`, { token: u.token });
    expect(r.status).toBe(400);
  });

  it("descendants=true rolls a child space's reputation into the parent", async () => {
    const pid = await createProject(); projects.push(pid);
    const owner = await createUser(pid);
    const parent = await seedSpace(pid, owner.id);
    const [child] = await getDb().insert(spaces).values({
      projectId: pid, shortId: `sr_${randomUUID().slice(0, 8)}`, name: "child", userId: owner.id, parentSpaceId: parent,
    }).returning();
    await setRep(pid, parent, owner.id, 10);
    await setRep(pid, child!.id, owner.id, 5);

    const flat = await api("GET", `${base(pid)}/users/${owner.id}?spaceReputationId=${parent}`, { token: owner.token });
    expect(flat.body.spaceReputation).toBe(10);
    const rolled = await api("GET", `${base(pid)}/users/${owner.id}?spaceReputationId=${parent}&spaceReputationDescendants=true`, { token: owner.token });
    expect(rolled.body.spaceReputation).toBe(15);
  });
});
```

- [ ] **Step 4: Run it to verify it fails, then passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation`
Expected: FAIL before Step 2's wiring is complete; PASS after. (Uses `TEST_DATABASE_URL`; see CLAUDE.md for the `TMPDIR` note.)

- [ ] **Step 5: Typecheck + unit suite**

Run: `pnpm -r typecheck && pnpm --filter @agora/api test`
Expected: clean; all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/space-rep.ts apps/api/src/routes/users.ts apps/api/test/integration/space-reputation.test.ts
git commit -m "feat(space-rep): spaceRepGate middleware + wire users (user-direct) end-to-end"
```

---

### Task 3: Wire `entities` + `comments` (incl. reaction listings)

**Files:**
- Modify: `apps/api/src/routes/entities.ts`, `apps/api/src/routes/comments.ts`
- Test: extend `apps/api/test/integration/space-reputation.test.ts`

**Interfaces:**
- Consumes: `spaceRepGate("context")`, `enrichSpaceReputation` (Tasks 1-2).

**Canonical transform** (applies to every user-embedding return in this task): mount the gate as the first chain link, then change `return c.json(PAYLOAD)` → `return c.json(await enrichSpaceReputation(c, PAYLOAD))`. Only wrap payloads that can embed a `User` (entity/comment with `include=user`, reaction lists). The pass no-ops on user-less payloads, but leave `{success}`/`{isSaved}`/`{recorded}`/count payloads unwrapped to avoid needless walks.

- [ ] **Step 1: Mount + wrap `entities.ts`**

Add imports:
```ts
import { spaceRepGate } from "../middleware/space-rep.js";
import { enrichSpaceReputation } from "../lib/space-reputation-enrich.js";
```
Mount: `export const entityRoutes = new Hono<{ Variables: Variables }>().use("*", spaceRepGate("context"))` then the existing chain.
Wrap these returns (current lines): `127` (`{ ...paginate(shaped, total, page, limit), rankAnchor }`), `197` (create `shaped`), `217` (feed list), `225`/`230`/`254` (`lookupEntity(...)`), `275` (single `shaped`), `296` (update `shaped`), `356` (`paginate(data, n, page, limit)` — the entity reactions list, which embeds `user`). Example for 356:
```ts
return c.json(await enrichSpaceReputation(c, paginate(data, n, page, limit)));
```

- [ ] **Step 2: Mount + wrap `comments.ts`**

Same imports + `.use("*", spaceRepGate("context"))`. Wrap: `80` (`paginate(shaped, …)`), `112` (create `shaped`), `129` (`{ comment: shaped }`), `176` (`{ data: roots }`), `192` (`{ comment: shaped }`), `209` (single `shaped`), `247` (`paginate(data, …)` — comment reactions list).

- [ ] **Step 3: Add integration coverage**

Append to `space-reputation.test.ts` a `describe("… — embedded (entities/comments)")` block. Sketch (fill in with the create helpers already used by other integration tests, e.g. `POST /entities`):
```ts
it("an entity's author carries spaceReputation on the single-GET", async () => {
  const pid = await createProject(); projects.push(pid);
  const author = await createUser(pid);
  const spaceId = await seedSpace(pid, author.id);
  await setRep(pid, spaceId, author.id, 8);
  const created = await api("POST", `${base(pid)}/entities`, { token: author.token, body: { spaceId, title: "t", content: "c" } });
  const id = created.body.id;
  const got = await api("GET", `${base(pid)}/entities/${id}?include=user&spaceReputationId=${spaceId}`, { token: author.token });
  expect(got.body.user.spaceReputation).toBe(8);
});
```
Add an analogous comment-author assertion.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation && pnpm -r typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/entities.ts apps/api/src/routes/comments.ts apps/api/test/integration/space-reputation.test.ts
git commit -m "feat(space-rep): enrich embedded users on entities + comments"
```

---

### Task 4: Wire `chat`

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Test: extend `apps/api/test/integration/space-reputation.test.ts`

**Interfaces:** Consumes `spaceRepGate("context")`, `enrichSpaceReputation`.

- [ ] **Step 1: Mount + wrap**

Add the two imports and `.use("*", spaceRepGate("context"))` as the first chain link. Apply the canonical transform to the user-embedding returns (current lines): `150` (`{ conversations: data, hasMore }` — previews carry `otherMembers[]`), `213` (`buildConversationPreview`), `220` (`shapeConversation(..., { currentMember })`), `271` (`{ currentMember: shapeConversationMember(row!) }`), `281` (`{ data: rows.map(shapeConversationMember(m, shapeUser(p))) }`), `295` (member add `shaped`), `315` (`shapeConversationMember(row)`), `358` (`{ messages, hasMore }` — messages embed `user`), `413` (message create `shaped`), `434` (`shapeChatMessage(row!)`), `532` (`shapeConversation(...)`). Leave `{ success }`/unread-count/`{ reactionCounts }` payloads unwrapped.

- [ ] **Step 2: Add integration coverage**

Append a chat block asserting a conversation member's / message author's `user.spaceReputation` after seeding a `space_reputation` row for that user (use the existing chat integration setup pattern — create a conversation, add a member). Assert the member list at `GET /chat/conversations/:id/members?spaceReputationId=<uuid>` carries `data[].user.spaceReputation`.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation && pnpm -r typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/test/integration/space-reputation.test.ts
git commit -m "feat(space-rep): enrich embedded users on chat (members/messages/previews)"
```

---

### Task 5: Wire `spaces` + `search` + `reports`

**Files:**
- Modify: `apps/api/src/routes/spaces.ts`, `apps/api/src/routes/search.ts`, `apps/api/src/routes/reports.ts`
- Test: extend `apps/api/test/integration/space-reputation.test.ts`

**Interfaces:** Consumes `spaceRepGate("context")`, `enrichSpaceReputation`.

- [ ] **Step 1: `spaces.ts`**

Imports + `.use("*", spaceRepGate("context"))`. Wrap the two user-embedding team/member returns: `346` (`paginate(data, …)` — members list, `data[].user`) and `355` (`{ data: rows.map((r) => ({ …, user: shapeUser(r.p) })) }`). Leave space/rule payloads unwrapped.

- [ ] **Step 2: `search.ts`**

Imports + `.use("*", spaceRepGate("context"))`. Wrap `164` (content results), `205` (ask results), `220` (`/users` search — `results[].record` is a `shapeUser`). Example:
```ts
return c.json(await enrichSpaceReputation(c, results));
```

- [ ] **Step 3: `reports.ts`**

Imports + `.use("*", spaceRepGate("context"))`. Wrap `53` (create `shapeReport`), `67` and `79` (`paginate(data, …)` report lists). Note: only **full-`User`** embeds are enriched; where a report embeds the reduced summary shape, the pass correctly skips it (verified in the test below).

- [ ] **Step 4: Add integration coverage**

Append assertions: (a) `GET /spaces/:id/members?spaceReputationId=<uuid>` → `data[].user.spaceReputation`; (b) `GET /search/users?query=…&spaceReputationId=<uuid>` (or the POST body form the route uses) → the matched user's `record`/object carries `spaceReputation`. Assert a full-User report field carries it if the report shape embeds a full User; otherwise assert the summary is left without the field (documents the intended skip).

- [ ] **Step 5: Verify**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation && pnpm -r typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/spaces.ts apps/api/src/routes/search.ts apps/api/src/routes/reports.ts apps/api/test/integration/space-reputation.test.ts
git commit -m "feat(space-rep): enrich embedded users on spaces/search/reports"
```

---

### Task 6: Wire `follows` + `connections` (relationships)

**Files:**
- Modify: `apps/api/src/routes/follows.ts`, `apps/api/src/routes/connections.ts`
- Test: extend `apps/api/test/integration/space-reputation.test.ts`

**Interfaces:** Consumes `spaceRepGate("context")`, `enrichSpaceReputation`. Note `connections` is mounted at the `/v7` root and derives `projectId` from the authed profile (`self.projectId`) — pass it as the third arg to `enrichSpaceReputation`.

- [ ] **Step 1: `follows.ts`**

Imports + `.use("*", spaceRepGate("context"))`. `follows` is under `/:projectId`, so `c.var.projectId` is set — no override needed. Wrap `44` and `48`:
```ts
return c.json(await enrichSpaceReputation(c, await selfFollowList(c.var.projectId, c.var.auth!.userId, "followers", page, limit, offset, c.req.query("query"), c.req.query("searchFields"))));
```
(and the `"following"` twin at 48). Leave the count payloads unwrapped.

- [ ] **Step 2: `connections.ts`**

Imports + `.use("*", spaceRepGate("context"))`. Because this router is root-mounted, `c.var.projectId` is NOT set — pass `self.projectId` explicitly. Wrap the user-embedding lists: `117` and `135` (`paginate(data, …)` — `data[].connectedUser`), `143` and `147` (`pendingList(...)` — embeds `user`). Example for 117 (the handler already has `self`):
```ts
return c.json(await enrichSpaceReputation(c, paginate(data, n, page, limit), self.projectId));
```
For `143`/`147`, `pendingList(c, self, …)` returns the payload — wrap with `self.projectId`:
```ts
return c.json(await enrichSpaceReputation(c, await pendingList(c, self, "received"), self.projectId));
```

- [ ] **Step 3: Add integration coverage**

Append: (a) follow `author` → `GET /users/:id/followers` already covered in Task 2, so add `GET /follows/followers?spaceReputationId=<uuid>` (self list) asserting `data[].spaceReputation`; (b) a connections list assertion — create a connected pair, seed a rep row for the connected user, `GET /connections?spaceReputationId=<uuid>` → `data[].connectedUser.spaceReputation`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation && pnpm -r typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/follows.ts apps/api/src/routes/connections.ts apps/api/test/integration/space-reputation.test.ts
git commit -m "feat(space-rep): enrich embedded users on follows + connections"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CHANGELOG.md`, `docs/MANIFEST.md`, `docs/MODELS.md`

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` → `### Added`:
```markdown
- **Space-reputation enrichment (SDK v7.8.2 #6):** user-embedding GET endpoints now accept
  `spaceReputationId` (`<uuid>` | `"none"`) and `spaceReputationDescendants`, attaching a space-scoped
  `spaceReputation` to returned/embedded users (`"none"` aliases global reputation; `<uuid>` reads the
  `space_reputation` store with optional descendant rollup). Covered: entities, comments, reaction
  listings, chat, spaces team/members, search, reports, follows, connections, and the users module.
  The `"context"` mode validates but is not yet computed (emits nothing); user-direct routes reject
  `"context"` with `400`.
```

- [ ] **Step 2: MODELS.md**

In `## User (public) / AuthUser / UserFull`, add `spaceReputation?` to the field list with a one-line note: "space-scoped reputation, present only when the request supplies `spaceReputationId` (v7.8.2 #6)". Remove any "scaffold / emits nothing" language for this feature if present.

- [ ] **Step 3: MANIFEST.md**

In the space-reputation section (§6 / wherever the param is described), change the "param validated, enrichment deferred" note to: the `uuid`/`none` modes are implemented across the covered endpoint families (list them); `"context"` is accepted on context routes but deferred (emits nothing) and rejected on user-direct routes.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/MODELS.md docs/MANIFEST.md
git commit -m "docs(space-rep): document spaceReputation enrichment param + coverage"
```

---

## Notes for the executor

- **Line numbers drift.** The per-task line numbers are from the current tree — after Task 2 mounts the gate, later line refs may shift by a few lines. Match on the `return c.json(...)` payload, not the number.
- **`spaceRepGate` mount placement:** always the FIRST `.use("*", …)` link so the directive is set before any handler runs.
- **Don't over-wrap.** Wrapping a user-less payload is harmless (no-op) but noisy — only wrap returns that can embed a `User`. When genuinely unsure, wrapping is the safe default.
- **`connections` projectId:** the only router where you MUST pass the third `projectId` arg (`self.projectId`); everywhere else `enrichSpaceReputation(c, payload)` reads `c.var.projectId`.
- **Out-of-scope routers** (`events`/`steward`/`admin`/`roles`/…) must NOT mount the gate — that's dead code and fails the coverage constraint.
