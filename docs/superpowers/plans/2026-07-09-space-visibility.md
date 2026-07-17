# Space-Visibility Discovery Filtering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the space `visibility` axis (`public`/`unlisted`/`private`) on discovery surfaces so a private space is hidden from listings/search and 404s on direct fetch for non-members, while `unlisted` is hidden from listings but link-fetchable.

**Architecture:** One new authority `apps/api/src/lib/space-visibility.ts` — a SQL list predicate (`discoverableSpacesSql`) pushed into listing/search WHEREs, plus a single-row 404 gate (`assertSpaceVisible` / `assertSpaceVisibleById`) applied to every direct-fetch and `GET /spaces/:id/*` sub-resource read. Mirrors the existing `lib/moderation-visibility.ts` pattern and reuses the ownership/active-member/project-admin logic from `lib/space-access.ts`.

**Tech Stack:** Hono, Drizzle (postgres.js), vitest (unit + real-Postgres integration). Design spec: `docs/superpowers/specs/2026-07-09-space-visibility-design.md`.

## Global Constraints

- **Two axes stay independent.** `visibility` gates SPACE-ROW discovery only; it must NOT touch content reads (entities/comments) or `includeChildSpaces` search scoping — those remain `readingPermission`'s job (`lib/space-access.ts`, unchanged).
- **404, never 403, for a hidden `private` space.** Use `Errors.notFound("spaces/not-found", "Space not found")` — a 403 would leak existence. A missing/deleted space and a hidden private space must be indistinguishable.
- **"Viewer may see it" = owner (`spaces.user_id`) ∨ active member (`space_members.status='active'`) ∨ project-admin (`isProjectAdmin(c.var.auth)`, which folds in operator ⊇ owner ⊇ admin).** A `pending`/`banned` (non-active) membership never grants visibility.
- **All SQL parameterized via the `sql` tag with explicit `::uuid` casts** — never string-interpolate user input.
- **Never push `undefined` into a typed `SQL[]`.** `discoverableSpacesSql` returns `SQL | undefined` (undefined = project-admin, unfiltered). Guard: `const d = discoverableSpacesSql(c); if (d) conds.push(d);` — or pass it directly to `and(...)`, which ignores `undefined`.
- **No DB migration, no contract/shape change.** The `visibility` column + enum exist (migration `0060`, default `public`); `shapeSpace` already emits it; `createSpaceSchema`/`updateSpaceSchema` already accept it.
- **Before done:** `pnpm --filter @agora/api typecheck` and `pnpm --filter @agora/api test` (unit) pass. Integration runs via the filter idiom (a bare `pnpm test:integration -- <name>` does NOT filter): `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-visibility` with `TEST_DATABASE_URL` set (prefix `TMPDIR="$HOME/.cache/agora-tmp"` to avoid `/private/tmp` `ENOSPC`).
- **Worktree note:** a fresh worktree has no `node_modules`/`dist` — run `pnpm install` + `pnpm -r build` (contract AND core) before any test.

---

### Task 1: The `space-visibility.ts` unit + unit tests

**Files:**
- Create: `apps/api/src/lib/space-visibility.ts`
- Test: `apps/api/src/lib/space-visibility.test.ts`

**Interfaces:**
- Consumes: `isProjectAdmin` (`lib/project-roles.ts`), `Errors` (`http/errors.ts`), `getDb` (`db/index.ts`), `spaces`/`spaceMembers` schema.
- Produces (used by Tasks 2-4):
  - `discoverableSpacesSql(c: Ctx): SQL | undefined`
  - `spaceVisibleToViewer(c: Ctx, space: { id: string; userId: string | null; visibility: string }): Promise<boolean>`
  - `assertSpaceVisible(c: Ctx, space: { id: string; userId: string | null; visibility: string }): Promise<void>`
  - `assertSpaceVisibleById(c: Ctx, spaceId: string): Promise<void>`

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/lib/space-visibility.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { discoverableSpacesSql, spaceVisibleToViewer, assertSpaceVisible } from "./space-visibility.js";

// Minimal Hono-context stub. Only the fields the unit reads: c.var.auth, c.var.projectId.
const ctx = (auth?: Record<string, unknown>) => ({ var: { auth, projectId: "p1" } }) as any;
const ADMIN = { userId: "admin", isOperator: false, isProjectOwner: false, isProjectAdmin: true };
const MEMBER = { userId: "u1", isOperator: false, isProjectOwner: false, isProjectAdmin: false };

const space = (visibility: string, userId: string | null = "owner") => ({ id: "s1", userId, visibility });

describe("discoverableSpacesSql", () => {
  it("returns undefined (unfiltered) for a project-admin", () => {
    expect(discoverableSpacesSql(ctx(ADMIN))).toBeUndefined();
  });
  it("returns a defined predicate for an anonymous viewer", () => {
    const sql = discoverableSpacesSql(ctx(undefined));
    expect(sql).not.toBeUndefined();
    expect(typeof sql).toBe("object");
  });
  it("returns a defined predicate for an authenticated non-admin", () => {
    const sql = discoverableSpacesSql(ctx(MEMBER));
    expect(sql).not.toBeUndefined();
    expect(typeof sql).toBe("object");
  });
});

describe("spaceVisibleToViewer (DB-free branches)", () => {
  it("public is visible to anyone, including anonymous", async () => {
    expect(await spaceVisibleToViewer(ctx(undefined), space("public"))).toBe(true);
  });
  it("unlisted is visible to anyone (link-shareable)", async () => {
    expect(await spaceVisibleToViewer(ctx(undefined), space("unlisted"))).toBe(true);
  });
  it("private is visible to a project-admin", async () => {
    expect(await spaceVisibleToViewer(ctx(ADMIN), space("private"))).toBe(true);
  });
  it("private is visible to its owner", async () => {
    expect(await spaceVisibleToViewer(ctx(MEMBER), space("private", "u1"))).toBe(true);
  });
  it("private is hidden from an anonymous viewer", async () => {
    expect(await spaceVisibleToViewer(ctx(undefined), space("private"))).toBe(false);
  });
});

describe("assertSpaceVisible", () => {
  it("resolves for a visible space", async () => {
    await expect(assertSpaceVisible(ctx(undefined), space("public"))).resolves.toBeUndefined();
  });
  it("throws 404 spaces/not-found for a hidden private space (never 403)", async () => {
    await expect(assertSpaceVisible(ctx(undefined), space("private"))).rejects.toMatchObject({
      status: 404,
      code: "spaces/not-found",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run src/lib/space-visibility.test.ts`
Expected: FAIL — `Cannot find module './space-visibility.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/lib/space-visibility.ts`:

```ts
// Read-path enforcement for the space `visibility` axis (space-ROW discovery). Distinct from
// lib/space-access.ts, which gates CONTENT inside a space via `readingPermission`. A space's
// `visibility` is public | unlisted | private:
//   - public   → listed in directories/search, directly fetchable
//   - unlisted → hidden from listings/search, directly fetchable by id/slug/short-id (link-shareable)
//   - private  → hidden from listings/search AND 404 on direct fetch unless the viewer is the owner,
//                an active member, or a project-admin (operator ⊇ owner ⊇ admin)
// One authority, mirroring lib/moderation-visibility.ts: a list predicate (discoverableSpacesSql) +
// a single-row 404 gate (assertSpaceVisible / assertSpaceVisibleById). We 404 (never 403) a hidden
// private space so a probe can't distinguish "private, not yours" from "doesn't exist".
import type { Context } from "hono";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { getDb } from "../db/index.js";
import { spaces, spaceMembers } from "../db/schema/index.js";
import { isProjectAdmin } from "./project-roles.js";

type Ctx = Context<{ Variables: Variables }>;
type VisibilityRow = { id: string; userId: string | null; visibility: string };

/**
 * SQL predicate for space-list/search queries: keep only spaces the caller may DISCOVER — public
 * spaces, plus any space the caller owns or is an active member of (regardless of that space's
 * visibility). Project-admins get `undefined` (unfiltered). Anonymous callers see public only.
 * Correlates to the outer `spaces` row via spaces.id / spaces.user_id / spaces.visibility, so it
 * drops into an existing `and(...conds)` WHERE. Parameterized with an explicit ::uuid cast.
 */
export function discoverableSpacesSql(c: Ctx): SQL | undefined {
  if (c.var.auth && isProjectAdmin(c.var.auth)) return undefined;
  const uid = c.var.auth?.userId ?? null;
  if (!uid) return sql`${spaces.visibility} = 'public'`;
  return sql`(${spaces.visibility} = 'public' or ${spaces.userId} = ${uid}::uuid or exists (
    select 1 from space_members m
    where m.space_id = ${spaces.id} and m.user_id = ${uid}::uuid and m.status = 'active'))`;
}

/**
 * True if the viewer may SEE this (possibly private) space row. Non-private spaces are always
 * visible; a private space only to the owner, an active member, or a project-admin. Hits the DB only
 * for the active-member branch (private + authenticated non-owner non-admin).
 */
export async function spaceVisibleToViewer(c: Ctx, space: VisibilityRow): Promise<boolean> {
  if (space.visibility !== "private") return true;
  if (c.var.auth && isProjectAdmin(c.var.auth)) return true;
  const uid = c.var.auth?.userId ?? null;
  if (!uid) return false;
  if (space.userId && space.userId === uid) return true;
  const [m] = await getDb()
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.projectId, c.var.projectId),
        eq(spaceMembers.spaceId, space.id),
        eq(spaceMembers.userId, uid),
        eq(spaceMembers.status, "active"),
      ),
    )
    .limit(1);
  return !!m;
}

/**
 * Single-row discovery gate when the handler already holds the space row. Throws 404
 * (spaces/not-found) for a hidden private space — never 403 (which would leak existence).
 */
export async function assertSpaceVisible(c: Ctx, space: VisibilityRow): Promise<void> {
  if (!(await spaceVisibleToViewer(c, space))) {
    throw Errors.notFound("spaces/not-found", "Space not found");
  }
}

/**
 * Same gate for handlers that don't load the space row. Loads a minimal (non-deleted) row and applies
 * assertSpaceVisible; a missing/deleted space also 404s (fail closed, indistinguishable from hidden).
 */
export async function assertSpaceVisibleById(c: Ctx, spaceId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: spaces.id, userId: spaces.userId, visibility: spaces.visibility })
    .from(spaces)
    .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!row) throw Errors.notFound("spaces/not-found", "Space not found");
  await assertSpaceVisible(c, row);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run src/lib/space-visibility.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agora/api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/space-visibility.ts apps/api/src/lib/space-visibility.test.ts
git commit -s -m "feat(spaces): add space-visibility discovery authority + unit tests"
```

---

### Task 2: Wire the listing/search surfaces

**Files:**
- Modify: `apps/api/src/routes/spaces.ts` (`GET /` ~L82; `GET /:id/children` ~L288)
- Modify: `apps/api/src/routes/search.ts` (`POST /spaces` ~L195)
- Test: `test/integration/space-visibility.test.ts` (create; listing/search/children blocks)

**Interfaces:**
- Consumes: `discoverableSpacesSql`, `assertSpaceVisibleById` (Task 1).

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/space-visibility.test.ts`:

```ts
// Integration: space `visibility` discovery filtering. Security-negative-first — every "hidden"
// and "404" row is asserted, not just the happy path. Isolated by project_id.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base, signToken } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { spaceMembers } from "../../src/db/schema/index.js";

describe("space visibility — listings & search (integration)", () => {
  let projectId: string, B: string;
  let owner: { id: string; token: string };
  let member: { id: string; token: string }; // active member of the private space
  let stranger: { id: string; token: string }; // no membership
  let adminToken: string;
  let publicId: string, unlistedId: string, privateId: string;

  const createSpace = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token, body: { name: "S", ...body } });

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [owner, member, stranger] = await Promise.all([
      createUser(projectId),
      createUser(projectId),
      createUser(projectId),
    ]);
    adminToken = await signToken((await createUser(projectId)).id, "visitor", false, false, false, true);
    publicId = (await createSpace(owner.token, { visibility: "public", slug: `pub-${projectId.slice(0, 8)}` })).body.id;
    unlistedId = (await createSpace(owner.token, { visibility: "unlisted", slug: `unl-${projectId.slice(0, 8)}` })).body.id;
    privateId = (await createSpace(owner.token, { visibility: "private", slug: `prv-${projectId.slice(0, 8)}` })).body.id;
    // Make `member` an active member of the private space (direct insert — deterministic).
    await getDb().insert(spaceMembers).values({
      projectId, spaceId: privateId, userId: member.id, role: "member", status: "active",
    });
  });

  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  const idsIn = (body: any) => new Set(body.data.map((s: any) => s.id));

  it("GET /spaces: anonymous sees only public", async () => {
    const res = await api("GET", `${B}/spaces?limit=100`);
    const ids = idsIn(res.body);
    expect(ids.has(publicId)).toBe(true);
    expect(ids.has(unlistedId)).toBe(false);
    expect(ids.has(privateId)).toBe(false);
  });

  it("GET /spaces: a stranger sees only public", async () => {
    const ids = idsIn((await api("GET", `${B}/spaces?limit=100`, { token: stranger.token })).body);
    expect(ids.has(publicId)).toBe(true);
    expect(ids.has(unlistedId)).toBe(false);
    expect(ids.has(privateId)).toBe(false);
  });

  it("GET /spaces: the private space's owner and active member see it", async () => {
    expect(idsIn((await api("GET", `${B}/spaces?limit=100`, { token: owner.token })).body).has(privateId)).toBe(true);
    expect(idsIn((await api("GET", `${B}/spaces?limit=100`, { token: member.token })).body).has(privateId)).toBe(true);
  });

  it("GET /spaces: a project-admin sees all three", async () => {
    const ids = idsIn((await api("GET", `${B}/spaces?limit=100`, { token: adminToken })).body);
    expect(ids.has(publicId) && ids.has(unlistedId) && ids.has(privateId)).toBe(true);
  });

  it("POST /search/spaces: a stranger's match excludes unlisted & private", async () => {
    const res = await api("POST", `${B}/search/spaces`, { token: stranger.token, body: { query: "S", limit: 100 } });
    const ids = new Set(res.body.map((r: any) => r.record.id));
    expect(ids.has(publicId)).toBe(true);
    expect(ids.has(unlistedId)).toBe(false);
    expect(ids.has(privateId)).toBe(false);
  });
});

describe("space visibility — children (integration)", () => {
  let projectId: string, B: string;
  let owner: { id: string; token: string };
  let stranger: { id: string; token: string };
  let publicParentId: string, privateChildId: string, privateParentId: string;

  const createSpace = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token, body: { name: "S", ...body } });

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [owner, stranger] = await Promise.all([createUser(projectId), createUser(projectId)]);
    publicParentId = (await createSpace(owner.token, { visibility: "public", slug: `pp-${projectId.slice(0, 8)}` })).body.id;
    privateChildId = (await createSpace(owner.token, { visibility: "private", parentSpaceId: publicParentId, slug: `pc-${projectId.slice(0, 8)}` })).body.id;
    privateParentId = (await createSpace(owner.token, { visibility: "private", slug: `pr-${projectId.slice(0, 8)}` })).body.id;
  });

  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("a private child is absent from a stranger's /children of a public parent", async () => {
    const res = await api("GET", `${B}/spaces/${publicParentId}/children?limit=100`, { token: stranger.token });
    expect(new Set(res.body.data.map((s: any) => s.id)).has(privateChildId)).toBe(false);
  });

  it("a private child is present for the owner", async () => {
    const res = await api("GET", `${B}/spaces/${publicParentId}/children?limit=100`, { token: owner.token });
    expect(new Set(res.body.data.map((s: any) => s.id)).has(privateChildId)).toBe(true);
  });

  it("a stranger hitting /children of a private parent gets 404", async () => {
    const res = await api("GET", `${B}/spaces/${privateParentId}/children`, { token: stranger.token });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("spaces/not-found");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-visibility`
Expected: FAIL — unlisted/private appear in listings; the private-parent `/children` returns 200 not 404. (Ensure `TEST_DATABASE_URL` is set; prefix `TMPDIR="$HOME/.cache/agora-tmp"`.)

- [ ] **Step 3: Wire `GET /spaces`**

In `apps/api/src/routes/spaces.ts`, add the import near the other lib imports:

```ts
import { discoverableSpacesSql, assertSpaceVisible, assertSpaceVisibleById } from "../lib/space-visibility.js";
```

In the `.get("/")` handler, after the search-field conditions and the `memberOf` block (just before the `sortByRaw` handling), add the discovery predicate:

```ts
    const disc = discoverableSpacesSql(c);
    if (disc) conds.push(disc);
```

- [ ] **Step 4: Wire `GET /spaces/:id/children`**

Replace the `.get("/:id/children")` handler body so it gates the parent and filters children:

```ts
  .get("/:id/children", async (c) => {
    await assertSpaceVisibleById(c, c.req.param("id"));
    const { page, limit, offset } = readPagination(c);
    const conds = [eq(spaces.projectId, c.var.projectId), eq(spaces.parentSpaceId, c.req.param("id")), isNull(spaces.deletedAt)];
    const disc = discoverableSpacesSql(c);
    if (disc) conds.push(disc);
    const where = and(...conds);
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(spaces).where(where);
    const rows = await getDb().select().from(spaces).where(where).orderBy(desc(spaces.createdAt)).limit(limit).offset(offset);
    return c.json(paginate(rows.map((r) => shapeSpace(r)), n, page, limit));
  })
```

- [ ] **Step 5: Wire `POST /search/spaces`**

In `apps/api/src/routes/search.ts`, add the import:

```ts
import { discoverableSpacesSql } from "../lib/space-visibility.js";
```

In the `.post("/spaces")` handler, pass the predicate into `and(...)` (which ignores `undefined`):

```ts
    const rows = await getDb().select().from(spaces)
      .where(and(
        eq(spaces.projectId, c.var.projectId),
        isNull(spaces.deletedAt),
        or(ilike(spaces.name, like), ilike(spaces.slug, like), ilike(spaces.description, like)),
        discoverableSpacesSql(c),
      ))
      .limit(limit);
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-visibility`
Expected: PASS (listings + search + children blocks).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @agora/api typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/spaces.ts apps/api/src/routes/search.ts test/integration/space-visibility.test.ts
git commit -s -m "feat(spaces): filter unlisted/private spaces from listings, search, and children"
```

---

### Task 3: Wire the direct-fetch surfaces + breadcrumb truncation

**Files:**
- Modify: `apps/api/src/routes/spaces.ts` (`GET /:id` ~L212; `by-slug` ~L158; `by-short-id` ~L150; `/:id/breadcrumb` ~L276)
- Test: `test/integration/space-visibility.test.ts` (append a direct-fetch + breadcrumb block)

**Interfaces:**
- Consumes: `assertSpaceVisible`, `spaceVisibleToViewer` (Task 1). Import already added in Task 2 — extend it to include `spaceVisibleToViewer`:
  `import { discoverableSpacesSql, assertSpaceVisible, assertSpaceVisibleById, spaceVisibleToViewer } from "../lib/space-visibility.js";`

- [ ] **Step 1: Write the failing integration test**

Append to `test/integration/space-visibility.test.ts`:

```ts
describe("space visibility — direct fetch & breadcrumb (integration)", () => {
  let projectId: string, B: string;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let stranger: { id: string; token: string };
  let adminToken: string;
  let publicId: string, unlistedId: string, privateId: string, privateSlug: string;
  let deepChildId: string; // public child under the private parent, for breadcrumb truncation

  const createSpace = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token, body: { name: "S", ...body } });

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [owner, member, stranger] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    adminToken = await signToken((await createUser(projectId)).id, "visitor", false, false, false, true);
    const sfx = projectId.slice(0, 8);
    publicId = (await createSpace(owner.token, { visibility: "public", slug: `pub2-${sfx}` })).body.id;
    unlistedId = (await createSpace(owner.token, { visibility: "unlisted", slug: `unl2-${sfx}` })).body.id;
    privateSlug = `prv2-${sfx}`;
    privateId = (await createSpace(owner.token, { visibility: "private", slug: privateSlug })).body.id;
    // Public child under the private parent → breadcrumb should truncate the private ancestor for a stranger.
    deepChildId = (await createSpace(owner.token, { visibility: "public", parentSpaceId: privateId, slug: `deep-${sfx}` })).body.id;
    await getDb().insert(spaceMembers).values({ projectId, spaceId: privateId, userId: member.id, role: "member", status: "active" });
  });

  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("GET /spaces/:id — public 200 for anyone", async () => {
    expect((await api("GET", `${B}/spaces/${publicId}`)).status).toBe(200);
  });
  it("GET /spaces/:id — unlisted 200 for a stranger (link-shareable)", async () => {
    expect((await api("GET", `${B}/spaces/${unlistedId}`, { token: stranger.token })).status).toBe(200);
  });
  it("GET /spaces/:id — private 404 for a stranger and for anonymous", async () => {
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: stranger.token })).status).toBe(404);
    expect((await api("GET", `${B}/spaces/${privateId}`)).status).toBe(404);
  });
  it("GET /spaces/:id — private 200 for owner, active member, admin", async () => {
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: owner.token })).status).toBe(200);
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: member.token })).status).toBe(200);
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: adminToken })).status).toBe(200);
  });
  it("GET /spaces/by-slug — private 404 for a stranger, 200 for owner", async () => {
    expect((await api("GET", `${B}/spaces/by-slug?slug=${privateSlug}`, { token: stranger.token })).status).toBe(404);
    expect((await api("GET", `${B}/spaces/by-slug?slug=${privateSlug}`, { token: owner.token })).status).toBe(200);
  });
  it("breadcrumb of a public child under a private parent — stranger sees the child only (ancestor truncated)", async () => {
    const res = await api("GET", `${B}/spaces/${deepChildId}/breadcrumb`, { token: stranger.token });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: any) => s.id);
    expect(ids).toEqual([deepChildId]); // private parent truncated
  });
  it("breadcrumb — owner sees the full chain (private parent → child)", async () => {
    const res = await api("GET", `${B}/spaces/${deepChildId}/breadcrumb`, { token: owner.token });
    expect(res.body.data.map((s: any) => s.id)).toEqual([privateId, deepChildId]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-visibility`
Expected: FAIL — private `GET /:id` and `by-slug` return 200; stranger's breadcrumb includes the private ancestor.

- [ ] **Step 3: Extend the import** in `spaces.ts` to include `spaceVisibleToViewer` (see Interfaces above).

- [ ] **Step 4: Gate `GET /:id`**

In the `.get("/:id")` handler, after `const space = await getSpace(c);` add:

```ts
    await assertSpaceVisible(c, space);
```

- [ ] **Step 5: Gate `by-slug` and `by-short-id`**

In `.get("/by-slug")`, after the `if (!row) throw ...` guard and before `return c.json(shapeSpace(row));`:

```ts
    await assertSpaceVisible(c, row);
```

Do the same in `.get("/by-short-id")` (after its `if (!row) throw ...`).

- [ ] **Step 6: Gate + truncate `GET /:id/breadcrumb`**

Replace the `.get("/:id/breadcrumb")` handler body:

```ts
  .get("/:id/breadcrumb", async (c) => {
    let current = await getSpace(c);
    await assertSpaceVisible(c, current); // gate the target (404 if hidden private)
    const chain: SpaceRow[] = [current];
    while (current.parentSpaceId) {
      const [p] = await getDb().select().from(spaces).where(eq(spaces.id, current.parentSpaceId)).limit(1);
      if (!p) break;
      if (!(await spaceVisibleToViewer(c, p))) break; // truncate at the first hidden ancestor
      chain.unshift(p);
      current = p;
    }
    return c.json({ data: chain.map((s) => shapeSpace(s)) });
  })
```

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-visibility`
Expected: PASS (direct-fetch + breadcrumb block, plus Task 2 blocks still green).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @agora/api typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/spaces.ts test/integration/space-visibility.test.ts
git commit -s -m "feat(spaces): 404 hidden private spaces on direct fetch; truncate breadcrumb ancestors"
```

---

### Task 4: Wire the sub-resource read gates (Thorough)

**Files:**
- Modify: `apps/api/src/routes/spaces.ts` (`/:id/members` ~L335; `/:id/team` ~L351; `/:id/rules` ~L428; `/:id/rules/:ruleId` ~L454; `/:id/membership/me` ~L312)
- Test: `test/integration/space-visibility.test.ts` (append a sub-resource block)

**Interfaces:**
- Consumes: `assertSpaceVisibleById`, `assertSpaceVisible` (Task 1; import already present).

- [ ] **Step 1: Write the failing integration test**

Append to `test/integration/space-visibility.test.ts`:

```ts
describe("space visibility — sub-resources (integration)", () => {
  let projectId: string, B: string;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let stranger: { id: string; token: string };
  let privateId: string;

  const createSpace = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token, body: { name: "S", ...body } });

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [owner, member, stranger] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    privateId = (await createSpace(owner.token, { visibility: "private", slug: `prv3-${projectId.slice(0, 8)}` })).body.id;
    await getDb().insert(spaceMembers).values({ projectId, spaceId: privateId, userId: member.id, role: "member", status: "active" });
  });

  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  for (const sub of ["members", "team", "rules"]) {
    it(`GET /spaces/:id/${sub} — 404 for a stranger on a private space`, async () => {
      const res = await api("GET", `${B}/spaces/${privateId}/${sub}`, { token: stranger.token });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("spaces/not-found");
    });
    it(`GET /spaces/:id/${sub} — 200 for an active member`, async () => {
      expect((await api("GET", `${B}/spaces/${privateId}/${sub}`, { token: member.token })).status).toBe(200);
    });
  }

  it("GET /spaces/:id/membership/me — 404 for a stranger on a private space", async () => {
    const res = await api("GET", `${B}/spaces/${privateId}/membership/me`, { token: stranger.token });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("spaces/not-found");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-visibility`
Expected: FAIL — sub-resources return 200 for a stranger on a private space.

- [ ] **Step 3: Gate the by-id sub-resources**

In `.get("/:id/members")`, `.get("/:id/team")`, `.get("/:id/rules")`, and `.get("/:id/rules/:ruleId")`, add as the FIRST line of each handler body:

```ts
    await assertSpaceVisibleById(c, c.req.param("id"));
```

- [ ] **Step 4: Gate `/:id/membership/me`**

In `.get("/:id/membership/me")`, after `const space = await getSpace(c);` add:

```ts
    await assertSpaceVisible(c, space);
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-visibility`
Expected: PASS (all four blocks green).

- [ ] **Step 6: Typecheck + full unit suite**

Run: `pnpm --filter @agora/api typecheck && pnpm --filter @agora/api test`
Expected: no type errors; unit suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/spaces.ts test/integration/space-visibility.test.ts
git commit -s -m "feat(spaces): gate space sub-resource reads by visibility (members/team/rules/membership)"
```

---

### Task 5: Docs — MANIFEST + CHANGELOG

**Files:**
- Modify: `docs/MANIFEST.md` (spaces section — note the visibility gate)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `Fixed`)

- [ ] **Step 1: Update MANIFEST**

In `docs/MANIFEST.md`, in the spaces section, add a short note that discovery surfaces now enforce `visibility`: `GET /spaces`, `POST /search/spaces`, and `GET /spaces/:id/children` exclude `unlisted`/`private` spaces the caller can't see; `GET /spaces/:id`, `/by-slug`, `/by-short-id`, `/:id/breadcrumb`, and the `/:id/{members,team,rules,membership/me}` reads return `404 spaces/not-found` for a hidden `private` space; `unlisted` stays directly fetchable by id/slug/short-id.

- [ ] **Step 2: Update CHANGELOG**

Under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md`, add:

```markdown
- **Space `visibility` is now enforced on discovery.** `unlisted` and `private` spaces are hidden from
  `GET /spaces`, `POST /search/spaces`, and `GET /spaces/:id/children`; a `private` space returns
  `404 spaces/not-found` on direct fetch (`GET /spaces/:id`, `/by-slug`, `/by-short-id`) and on its
  `/breadcrumb`, `/members`, `/team`, `/rules`, and `/membership/me` reads for anyone who is not the
  owner, an active member, or a project-admin — closing a hole where private spaces were fully
  discoverable (persist-only since migration `0060`). `unlisted` stays link-shareable (fetchable by
  id/slug/short-id, just not listed). Content-read access (`readingPermission`) is unchanged and
  independent.
```

- [ ] **Step 3: Commit**

```bash
git add docs/MANIFEST.md CHANGELOG.md
git commit -s -m "docs(spaces): document the space-visibility discovery gate"
```

---

## Self-review notes

- **Spec coverage:** matrix (public/unlisted/private × listing/direct/sub-resource) → Tasks 2/3/4; unit authority → Task 1; docs → Task 5. Breadcrumb truncation and the `check-slug` exemption from the spec are covered (Task 3; `check-slug` deliberately untouched).
- **Type consistency:** `discoverableSpacesSql` returns `SQL | undefined` and is always consumed via `if (d) conds.push(d)` or passed directly to `and(...)`; `spaceVisibleToViewer`/`assertSpaceVisible` take `{ id, userId, visibility }` (a subset of the full `SpaceRow`, so `getSpace`/`by-slug` rows are assignable).
- **No placeholders:** every code step shows the exact code.
- **Global constraint — 404 not 403:** every gate throws `Errors.notFound("spaces/not-found", ...)`; the integration tests assert `status === 404` AND `code === "spaces/not-found"`.
