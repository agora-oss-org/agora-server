# Internet-Public Entities + Anonymous `/public/*` Read Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let privileged users flag a community-public entity as internet-public, and serve that entity + its comment thread anonymously through a new GET-only `/public/*` surface that pierces the auth wall.

**Architecture:** One new `entities.is_public` column (migration 0065); a pure ladder predicate + DB-backed gate in `lib/public-access.ts`; a privileged `PATCH /entities/:id/visibility` action in the walled entities router; a new anonymous `routes/public.ts` router mounted at `/v7/:projectId/public/*` and allowlisted on the auth wall via one `"/public/"` prefix entry.

**Tech Stack:** Hono, Drizzle (postgres.js), zod (`@agora-server/contract`), vitest (unit + real-Postgres integration).

**Spec:** `docs/superpowers/specs/2026-07-18-internet-public-entities-design.md` — read it before starting.

## Global Constraints

- **Commit authorization:** Jenova's standing rule — NO `git commit` without asking her first. At execution pre-flight, ask whether per-task commits are authorized for this run; if not granted, skip every "Commit" step and leave changes staged/unstaged.
- Monorepo build order: `@agora-server/contract` → `@agora/core` → `@agora/api`. After editing contract or core, run `pnpm --filter @agora-server/contract build && pnpm --filter @agora/core build` (from repo root) before typechecking the api.
- Before claiming any task done: `pnpm -r typecheck` and (for unit-test tasks) `cd apps/api && pnpm test` must pass.
- Integration suite: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api test:integration` (create the dir once: `mkdir -p "$HOME/.cache/agora-tmp"`). Needs `TEST_DATABASE_URL` in `apps/api/.env`. Single file: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <name>` (a bare `pnpm test:integration -- <name>` runs the WHOLE suite — don't).
- Migration is applied with `pnpm --filter @agora/api db:migrate:run` — NEVER `db:migrate` (drizzle-kit journal misconfigured). The integration suite's `global-setup.ts` applies migrations to the test DB on first run automatically.
- Errors: always `throw Errors.*` (`{ error, code, field? }` envelope), never bare strings. Logging: shared `logger`, data-object-FIRST (`logger.debug({ err }, "msg")`); `info`/`error` are message-only.
- The anonymous surface must **never** 403 or otherwise reveal that a non-public entity exists — always `404 entities/not-found`.
- Follow existing file conventions (header comments naming the route prefix, `.js` import suffixes, static-routes-above-`/:id`).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/db/schema/content.ts` | Modify | `isPublic` column on `entities` |
| `apps/api/drizzle/0065_entity_internet_public.sql` | Create | hand-authored DDL |
| `apps/api/drizzle/meta/_journal.json` | Modify | journal entry idx 65 |
| `packages/contract/src/types.ts` | Modify | `Entity.public` field |
| `packages/contract/src/schemas.ts` | Modify | `entityVisibilitySchema` |
| `apps/api/src/lib/shape.ts` | Modify | shaper emits `public` |
| `apps/api/src/lib/shape.test.ts` | Modify | pin the new field |
| `apps/api/src/lib/public-access.ts` | Create | pure ladder predicate + DB gate |
| `apps/api/src/lib/public-access.test.ts` | Create | predicate matrix |
| `apps/api/src/routes/entities.ts` | Modify | `PATCH /:id/visibility` |
| `apps/api/src/routes/public.ts` | Create | anonymous GET surface |
| `apps/api/src/routes/index.ts` | Modify | mount `/public` |
| `packages/core/src/middleware/auth.ts` | Modify | allowlist `"/public/"` prefix |
| `apps/api/src/middleware/auth-wall.test.ts` | Modify | re-pin the allowlist |
| `apps/api/test/integration/public-read.test.ts` | Create | end-to-end security matrix |
| `docs/MANIFEST.md`, `docs/MODELS.md`, `CHANGELOG.md` | Modify | contract docs |

---

### Task 1: Migration 0065 + Drizzle schema column

**Files:**
- Modify: `packages/core/src/db/schema/content.ts` (the `entities` table, after `isDraft` at ~line 35)
- Create: `apps/api/drizzle/0065_entity_internet_public.sql`
- Modify: `apps/api/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `entities.isPublic` (Drizzle property, column `is_public`, `boolean NOT NULL DEFAULT false`) — Tasks 2–5 read/write it as `row.isPublic` / `set({ isPublic })`.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `packages/core/src/db/schema/content.ts`, inside `export const entities = pgTable("entities", {`, directly below the `isDraft` line:

```ts
  isDraft: boolean("is_draft").default(false),
  // Internet-public flag — the top rung of the visibility ladder (anonymous /public/* surface).
  // Ladder-validated on write (only community-public content may be flagged); the read gate
  // re-derives `isPublic AND space-is-public` live, so a stale true is harmless (fail closed).
  isPublic: boolean("is_public").notNull().default(false),
```

- [ ] **Step 2: Write the hand-authored migration**

Create `apps/api/drizzle/0065_entity_internet_public.sql`:

```sql
-- apps/api/drizzle/0065_entity_internet_public.sql
-- Internet-public flag (visibility-ladder top rung): opts an entity (and its comment thread) into
-- the anonymous GET-only /public/* read surface. Privileged write (operator/project-admin/space-
-- admin) via PATCH /entities/:id/visibility; the read gate re-derives is_public AND space-is-public
-- live on every request (fail closed). Column mirrors is_draft naming. Idempotent.
-- Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
```

- [ ] **Step 3: Append the journal entry**

In `apps/api/drizzle/meta/_journal.json`, append to `entries` (after idx 64 — `when` MUST exceed the current max `1781934611662`, per the journal-watermark gotcha):

```json
{ "idx": 65, "version": "7", "when": 1784246400000, "tag": "0065_entity_internet_public", "breakpoints": true }
```

First re-confirm 0065 is still the next free number: `ls apps/api/drizzle/ | sort | tail -3` must show `0064_...` as the highest. (Two parked plans also reserved 0065 — they are unexecuted docs; if one has since landed, renumber to the next free slot everywhere in this task.)

- [ ] **Step 4: Rebuild core + apply the migration to the dev DB**

```bash
pnpm --filter @agora-server/contract build && pnpm --filter @agora/core build
pnpm --filter @agora/api db:migrate:run
pnpm --filter @agora/api db:migrate:run   # idempotency: second run must be a clean no-op
```

Expected: first run applies `0065_entity_internet_public`, second run applies nothing, neither errors.

- [ ] **Step 5: Typecheck**

```bash
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit** *(only if per-task commits were authorized at pre-flight)*

```bash
git add packages/core/src/db/schema/content.ts apps/api/drizzle/0065_entity_internet_public.sql apps/api/drizzle/meta/_journal.json
git commit -s -m "feat(db): entities.is_public internet-visibility flag (0065)"
```

---

### Task 2: Contract field + schema, shaper

**Files:**
- Modify: `packages/contract/src/types.ts` (the `Entity` interface, ~line 30)
- Modify: `packages/contract/src/schemas.ts`
- Modify: `apps/api/src/lib/shape.ts` (`shapeEntity`, ~line 62)
- Test: `apps/api/src/lib/shape.test.ts`, `apps/api/src/lib/contract-schemas.test.ts`

**Interfaces:**
- Consumes: `entities.isPublic` (Task 1).
- Produces: `Entity.public: boolean` (shaped API field); `entityVisibilitySchema` = `z.object({ public: z.boolean() })`, exported from `@agora-server/contract` and reachable via `apps/api`'s `lib/validation.js` re-export shim (no shim edit needed — it `export *`s the contract). Task 4 parses with it; Task 5's tests assert the field.

- [ ] **Step 1: Write the failing unit tests**

In `apps/api/src/lib/shape.test.ts`, inside the existing `shapeEntity` describe block (create one if the file groups differently — mirror its local row-fixture style; the file already builds minimal `EntityRow` fixtures):

```ts
it("emits the internet-visibility flag as `public`", () => {
  expect(shapeEntity(makeEntityRow({ isPublic: true })).public).toBe(true);
  expect(shapeEntity(makeEntityRow({ isPublic: false })).public).toBe(false);
});
```

(`makeEntityRow` = whatever row-fixture helper the file already uses; add `isPublic` to its defaults with `false`.)

In `apps/api/src/lib/contract-schemas.test.ts`:

```ts
describe("entityVisibilitySchema", () => {
  it("accepts a boolean public flag", () => {
    expect(entityVisibilitySchema.parse({ public: true })).toEqual({ public: true });
    expect(entityVisibilitySchema.parse({ public: false })).toEqual({ public: false });
  });
  it("rejects missing/non-boolean", () => {
    expect(entityVisibilitySchema.safeParse({}).success).toBe(false);
    expect(entityVisibilitySchema.safeParse({ public: "yes" }).success).toBe(false);
  });
});
```

(Import `entityVisibilitySchema` the same way that file imports its other schemas.)

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && pnpm test -- shape && pnpm test -- contract-schemas
```

Expected: FAIL (`public` undefined; `entityVisibilitySchema` not exported).

- [ ] **Step 3: Implement**

`packages/contract/src/types.ts`, in `interface Entity`, after `isDraft: boolean;`:

```ts
  isDraft: boolean;
  /** Internet-visibility flag: true ⇒ readable anonymously via the /public/* surface (Agora extension). */
  public: boolean;
```

`packages/contract/src/schemas.ts`, near the other entity schemas:

```ts
/** PATCH /entities/:id/visibility — privileged internet-visibility action (Agora extension). */
export const entityVisibilitySchema = z.object({ public: z.boolean() });
```

`apps/api/src/lib/shape.ts`, in `shapeEntity`'s object literal, after `isDraft: row.isDraft ?? false,`:

```ts
    isDraft: row.isDraft ?? false,
    public: row.isPublic ?? false,
```

- [ ] **Step 4: Rebuild contract, run tests**

```bash
pnpm --filter @agora-server/contract build && pnpm --filter @agora/core build
cd apps/api && pnpm test -- shape && pnpm test -- contract-schemas && cd ../.. && pnpm -r typecheck
```

Expected: PASS. (If other shape tests snapshot full Entity objects, update those fixtures to include `public: false`.)

- [ ] **Step 5: Commit** *(only if authorized)*

```bash
git add packages/contract/src/types.ts packages/contract/src/schemas.ts apps/api/src/lib/shape.ts apps/api/src/lib/shape.test.ts apps/api/src/lib/contract-schemas.test.ts
git commit -s -m "feat(contract): Entity.public field + entityVisibilitySchema"
```

---

### Task 3: `lib/public-access.ts` — the internet-public gate

**Files:**
- Create: `apps/api/src/lib/public-access.ts`
- Test: `apps/api/src/lib/public-access.test.ts`

**Interfaces:**
- Consumes: `entities.isPublic` (Task 1); `getDb()`, `Errors`, Drizzle tables.
- Produces:
  - `isInternetPublic(e: InternetPublicEntityCheck, space: InternetPublicSpaceCheck | null): boolean` — pure ladder predicate.
  - `assertEntityInternetPublic(projectId: string, entityId: string): Promise<typeof entities.$inferSelect>` — throws `404 entities/not-found` unless the entity is live-internet-public; returns the full entity row on success. Task 5 calls this at the top of EVERY public route.

- [ ] **Step 1: Write the failing predicate matrix test**

Create `apps/api/src/lib/public-access.test.ts`:

```ts
// Ladder predicate matrix (spec §3): public AND not deleted AND not draft AND not removed AND
// (spaceless OR live public space). Pure — the DB-backed assert is covered by
// test/integration/public-read.test.ts.
import { describe, it, expect } from "vitest";
import { isInternetPublic } from "./public-access.js";

const base = { isPublic: true, deletedAt: null, isDraft: false, moderationStatus: null, spaceId: null };
const pubSpace = { readingPermission: "anyone", deletedAt: null };

describe("isInternetPublic", () => {
  it("admits a public, live, spaceless entity", () => {
    expect(isInternetPublic(base, null)).toBe(true);
  });
  it("admits a public entity in a live public space", () => {
    expect(isInternetPublic({ ...base, spaceId: "s1" }, pubSpace)).toBe(true);
  });
  it("rejects when the flag is off", () => {
    expect(isInternetPublic({ ...base, isPublic: false }, null)).toBe(false);
  });
  it("rejects deleted / draft / moderation-removed", () => {
    expect(isInternetPublic({ ...base, deletedAt: new Date() }, null)).toBe(false);
    expect(isInternetPublic({ ...base, isDraft: true }, null)).toBe(false);
    expect(isInternetPublic({ ...base, moderationStatus: "removed" }, null)).toBe(false);
  });
  it("rejects a members-only, deleted, or missing space (fail closed)", () => {
    expect(isInternetPublic({ ...base, spaceId: "s1" }, { readingPermission: "members", deletedAt: null })).toBe(false);
    expect(isInternetPublic({ ...base, spaceId: "s1" }, { readingPermission: "anyone", deletedAt: new Date() })).toBe(false);
    expect(isInternetPublic({ ...base, spaceId: "s1" }, null)).toBe(false);
  });
  it("ignores an approved moderation status", () => {
    expect(isInternetPublic({ ...base, moderationStatus: "approved" }, null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && pnpm test -- public-access
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/public-access.ts`:

```ts
// Internet-public read gate for the anonymous /v7/:projectId/public/* surface.
// Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
//
// Every /public route calls assertEntityInternetPublic INDEPENDENTLY — no route trusts that
// another ran first. The check is live (no cache) and fail-closed: flipping the space to
// members-only, soft-deleting, re-drafting, or moderation-removing the entity instantly
// un-exposes it even while is_public is still true. Always 404, never 403 — the anonymous
// surface must not reveal that a non-public entity exists.
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { entities, spaces } from "../db/schema/index.js";
import { Errors } from "../http/errors.js";

export interface InternetPublicEntityCheck {
  isPublic: boolean;
  deletedAt: Date | null;
  isDraft: boolean | null;
  moderationStatus: string | null;
  spaceId: string | null;
}
export interface InternetPublicSpaceCheck {
  readingPermission: string;
  deletedAt: Date | null;
}

/** Pure ladder predicate: internet ⊇ community ⊇ private. */
export function isInternetPublic(
  e: InternetPublicEntityCheck,
  space: InternetPublicSpaceCheck | null,
): boolean {
  if (!e.isPublic || e.deletedAt || e.isDraft) return false;
  if (e.moderationStatus === "removed") return false;
  if (e.spaceId === null) return true;
  if (!space || space.deletedAt) return false;
  return space.readingPermission === "anyone";
}

const uuid = z.string().uuid();
const notFound = () => Errors.notFound("entities/not-found", "Entity not found");

/** Load + gate; returns the entity row or throws 404. A malformed id 404s (not 500s) — this
 *  surface is probed by anonymous strangers. */
export async function assertEntityInternetPublic(projectId: string, entityId: string) {
  if (!uuid.safeParse(entityId).success) throw notFound();
  const [row] = await getDb()
    .select({ entity: entities, spaceReading: spaces.readingPermission, spaceDeletedAt: spaces.deletedAt })
    .from(entities)
    .leftJoin(spaces, and(eq(spaces.id, entities.spaceId), eq(spaces.projectId, projectId)))
    .where(and(eq(entities.projectId, projectId), eq(entities.id, entityId)))
    .limit(1);
  if (!row) throw notFound();
  const space = row.spaceReading
    ? { readingPermission: row.spaceReading, deletedAt: row.spaceDeletedAt }
    : null;
  const e = row.entity;
  if (!isInternetPublic(
    { isPublic: e.isPublic, deletedAt: e.deletedAt, isDraft: e.isDraft, moderationStatus: e.moderationStatus, spaceId: e.spaceId },
    space,
  )) throw notFound();
  return e;
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
cd apps/api && pnpm test -- public-access && cd ../.. && pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit** *(only if authorized)*

```bash
git add apps/api/src/lib/public-access.ts apps/api/src/lib/public-access.test.ts
git commit -s -m "feat(api): internet-public ladder gate (lib/public-access)"
```

---

### Task 4: `PATCH /entities/:id/visibility` (privileged write)

**Files:**
- Modify: `apps/api/src/routes/entities.ts`
- Test: `apps/api/test/integration/public-read.test.ts` (created here with the write-side matrix; Task 5 extends it)

**Interfaces:**
- Consumes: `entityVisibilitySchema` (Task 2, via `../lib/validation.js`), `entities.isPublic` (Task 1), `isProjectAdmin` from `../lib/project-roles.js`, `spaces`/`spaceMembers` tables.
- Produces: the route `PATCH /v7/:projectId/entities/:id/visibility` → shaped entity (with `public`). Codes: `404 entities/not-found` (missing, or caller can't read), `403 entities/not-authorized`, `400 entities/not-community-public`, `400 entities/invalid-body`.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/test/integration/public-read.test.ts`:

```ts
// Internet-public entities: the privileged visibility action + (Task 5) the anonymous /public/*
// surface. Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
// Security-first: the negative cases (403/404/400, the no-existence-oracle posture) are the point.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/index.js";
import { entities, comments, spaces, spaceMembers } from "../../src/db/schema/index.js";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";

let projectId: string;

beforeAll(async () => { projectId = await createProject(); });
afterAll(async () => { await deleteProject(projectId); });

async function makeSpace(reading: "anyone" | "members", ownerId?: string) {
  const [s] = await getDb().insert(spaces).values({
    projectId, shortId: randomUUID().slice(0, 10), name: "s",
    readingPermission: reading, userId: ownerId,
  }).returning();
  return s!;
}
async function addMember(spaceId: string, userId: string, role: "member" | "admin" | "moderator" = "member") {
  await getDb().insert(spaceMembers).values({ projectId, spaceId, userId, role, status: "active" });
}
async function makeEntity(opts: {
  spaceId?: string | null; isPublic?: boolean; isDraft?: boolean;
  userId?: string; deletedAt?: Date; moderationStatus?: "removed";
} = {}) {
  const [e] = await getDb().insert(entities).values({
    projectId, shortId: randomUUID().slice(0, 10), content: "hello world",
    spaceId: opts.spaceId ?? null, isPublic: opts.isPublic ?? false,
    isDraft: opts.isDraft ?? false, userId: opts.userId,
    deletedAt: opts.deletedAt, moderationStatus: opts.moderationStatus,
  }).returning();
  return e!;
}
async function makeComment(entityId: string, userId: string, opts: {
  content?: string; moderationStatus?: "removed"; deletedAt?: Date; parentId?: string;
} = {}) {
  const [r] = await getDb().insert(comments).values({
    projectId, entityId, userId, content: opts.content ?? "a comment",
    moderationStatus: opts.moderationStatus, deletedAt: opts.deletedAt,
    userDeletedAt: opts.deletedAt, parentId: opts.parentId,
  }).returning();
  return r!;
}
const vis = (id: string, token: string | undefined, pub: boolean) =>
  api("PATCH", `${base(projectId)}/entities/${id}/visibility`, { token, body: { public: pub } });

describe("PATCH /entities/:id/visibility — authority", () => {
  it("403s an ordinary member and the author; 200s a space admin; 403s a space moderator", async () => {
    const admin = await createUser(projectId);
    const modr = await createUser(projectId);
    const member = await createUser(projectId);
    const author = await createUser(projectId);
    const s = await makeSpace("anyone");
    for (const [u, role] of [[admin, "admin"], [modr, "moderator"], [member, "member"], [author, "member"]] as const)
      await addMember(s.id, u.id, role);
    const e = await makeEntity({ spaceId: s.id, userId: author.id });

    expect((await vis(e.id, member.token, true)).status).toBe(403);
    expect((await vis(e.id, author.token, true)).status).toBe(403);
    expect((await vis(e.id, modr.token, true)).status).toBe(403);
    const ok = await vis(e.id, admin.token, true);
    expect(ok.status).toBe(200);
    expect(ok.body.public).toBe(true);
  });

  it("200s the space owner, a project admin, and an operator", async () => {
    const owner = await createUser(projectId);
    const s = await makeSpace("anyone", owner.id);
    const e = await makeEntity({ spaceId: s.id });
    expect((await vis(e.id, owner.token, true)).status).toBe(200);

    const pa = await createUser(projectId);
    const paToken = await signToken(pa.id, "visitor", false, false, false, true, projectId);
    expect((await vis(e.id, paToken, false)).status).toBe(200);

    const op = await createUser(projectId);
    const opToken = await signToken(op.id, "visitor", true, false, false, false, projectId);
    expect((await vis(e.id, opToken, true)).status).toBe(200);
  });

  it("spaceless entity: project admin 200, ordinary user 403", async () => {
    const e = await makeEntity();
    const u = await createUser(projectId);
    expect((await vis(e.id, u.token, true)).status).toBe(403);
    const pa = await createUser(projectId);
    const paToken = await signToken(pa.id, "visitor", false, false, false, true, projectId);
    expect((await vis(e.id, paToken, true)).status).toBe(200);
  });
});

describe("PATCH /entities/:id/visibility — posture + ladder", () => {
  it("404s (never 403s) a non-member probing a members-only-space entity", async () => {
    const s = await makeSpace("members");
    const e = await makeEntity({ spaceId: s.id });
    const stranger = await createUser(projectId);
    const res = await vis(e.id, stranger.token, true);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("entities/not-found");
  });

  it("404s a nonexistent and a malformed entity id", async () => {
    const u = await createUser(projectId);
    expect((await vis(randomUUID(), u.token, true)).status).toBe(404);
    expect((await api("PATCH", `${base(projectId)}/entities/not-a-uuid/visibility`, { token: u.token, body: { public: true } })).status).toBe(404);
  });

  it("400s the ladder: public:true on a members-only-space entity (even for its admin)", async () => {
    const admin = await createUser(projectId);
    const s = await makeSpace("members");
    await addMember(s.id, admin.id, "admin");
    const e = await makeEntity({ spaceId: s.id });
    const res = await vis(e.id, admin.token, true);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("entities/not-community-public");
  });

  it("always allows public:false (un-publish), even after the space went members-only", async () => {
    const admin = await createUser(projectId);
    const s = await makeSpace("anyone");
    await addMember(s.id, admin.id, "admin");
    const e = await makeEntity({ spaceId: s.id, isPublic: true });
    await getDb().update(spaces).set({ readingPermission: "members" }).where(eq(spaces.id, s.id));
    const res = await vis(e.id, admin.token, false);
    expect(res.status).toBe(200);
    expect(res.body.public).toBe(false);
  });

  it("400s a malformed body", async () => {
    const e = await makeEntity();
    const pa = await createUser(projectId);
    const paToken = await signToken(pa.id, "visitor", false, false, false, true, projectId);
    expect((await api("PATCH", `${base(projectId)}/entities/${e.id}/visibility`, { token: paToken, body: {} })).status).toBe(400);
    expect((await api("PATCH", `${base(projectId)}/entities/${e.id}/visibility`, { token: paToken, body: { public: "yes" } })).status).toBe(400);
  });

  it("401s an anonymous caller (the action stays behind the wall)", async () => {
    const e = await makeEntity({ isPublic: true });
    expect((await vis(e.id, undefined, true)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
mkdir -p "$HOME/.cache/agora-tmp"
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts public-read
```

Expected: FAIL — the visibility route 404s (route doesn't exist ⇒ Hono `/:id` doesn't match the extra segment, `common/not-found`), so the 200/403/400 cases fail.

- [ ] **Step 3: Implement the route**

In `apps/api/src/routes/entities.ts`:

Add to the imports: `spaceMembers` in the schema import line; `isProjectAdmin` and the schema:

```ts
import { entities, reactions, collections, collectionEntities, spaces, spaceMembers, readReceipts } from "../db/schema/index.js";
import { isProjectAdmin } from "../lib/project-roles.js";
import {
  parseBody,
  createEntitySchema,
  updateEntitySchema,
  entityVisibilitySchema,
  reactionSchema,
} from "../lib/validation.js";
```

Add the route directly after the `.on(["POST", "PATCH"], "/:id/publish", …)` block:

```ts
  // Internet-visibility action (visibility-ladder top rung; Agora extension). Named /visibility,
  // NOT /public, to avoid confusion with the anonymous /public/* read namespace. Privileged:
  // operator/project-admin (isProjectAdmin folds both in), the space owner, or a space `admin`
  // member — never the author. 404-posture: a caller who cannot READ the entity must not learn it
  // exists. Ladder: public:true only for community-public content; public:false always allowed.
  // Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
  .patch("/:id/visibility", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const id = c.req.param("id");
    const { public: isPublic } = parseBody(entityVisibilitySchema, await c.req.json().catch(() => ({})), "entities");
    const notFound = () => Errors.notFound("entities/not-found", "Entity not found");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound();
    const [row] = await getDb()
      .select({
        entity: entities,
        spaceOwnerId: spaces.userId,
        spaceReading: spaces.readingPermission,
        spaceDeletedAt: spaces.deletedAt,
      })
      .from(entities)
      .leftJoin(spaces, and(eq(spaces.id, entities.spaceId), eq(spaces.projectId, projectId)))
      .where(and(eq(entities.projectId, projectId), eq(entities.id, id), isNull(entities.deletedAt)))
      .limit(1);
    if (!row) throw notFound();

    const auth = c.var.auth!;
    let authorized = isProjectAdmin(auth);
    let membershipRole: string | null = null;
    if (!authorized && row.entity.spaceId) {
      if (row.spaceOwnerId && row.spaceOwnerId === auth.userId) authorized = true;
      else {
        const [m] = await getDb()
          .select({ role: spaceMembers.role })
          .from(spaceMembers)
          .where(and(
            eq(spaceMembers.projectId, projectId),
            eq(spaceMembers.spaceId, row.entity.spaceId),
            eq(spaceMembers.userId, auth.userId),
            eq(spaceMembers.status, "active"),
          ))
          .limit(1);
        membershipRole = m?.role ?? null;
        if (membershipRole === "admin") authorized = true;
      }
    }
    if (!authorized) {
      // No existence oracle: a caller with no read access to a members-only space's entity gets
      // the same 404 a nonexistent id gets. A live public space (or spaceless) is readable ⇒ 403.
      const readable = !row.entity.spaceId || (!row.spaceDeletedAt && row.spaceReading === "anyone") || membershipRole !== null;
      if (!readable) throw notFound();
      throw Errors.forbidden("entities/not-authorized", "Not authorized to change this entity's visibility");
    }
    if (isPublic) {
      const communityPublic = !row.entity.spaceId || (!row.spaceDeletedAt && row.spaceReading === "anyone");
      if (!communityPublic) {
        throw Errors.badRequest("entities/not-community-public", "Only content in a public space (or no space) can be made internet-public");
      }
    }
    const [updated] = await getDb().update(entities).set({ isPublic }).where(eq(entities.id, row.entity.id)).returning();
    logger.info({ projectId, entityId: id, userId: auth.userId, public: isPublic }, "entity: internet visibility changed");
    return c.json(await enrichSpaceReputation(c, shapeEntity(updated!)));
  })
```

- [ ] **Step 4: Run the integration file + typecheck**

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts public-read
pnpm -r typecheck
```

Expected: PASS (all Task-4 describes green).

- [ ] **Step 5: Commit** *(only if authorized)*

```bash
git add apps/api/src/routes/entities.ts apps/api/test/integration/public-read.test.ts
git commit -s -m "feat(api): privileged PATCH /entities/:id/visibility (internet-public ladder)"
```

---

### Task 5: Anonymous `/public/*` router + auth-wall allowlist + CORS

**Files:**
- Create: `apps/api/src/routes/public.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `packages/core/src/middleware/auth.ts` (~line 75, `AUTH_WALL_ALLOWLIST`)
- Modify: `apps/api/src/middleware/auth-wall.test.ts`
- Test: extend `apps/api/test/integration/public-read.test.ts`

**Interfaces:**
- Consumes: `assertEntityInternetPublic` (Task 3), `Entity.public` shaping (Task 2), existing `shapeComment`/`shapeEntity`/`loadUsers`/`loadEntityFiles`/`paginate`/`readPagination`/`resolveCommentSort`/`commentOrderBy`/`parseInclude`.
- Produces: `GET /v7/:projectId/public/entities/:id`, `GET …/comments`, `GET …/comments/thread` — anonymous; `Access-Control-Allow-Origin: *`; allowlist prefix `"/public/"`.

- [ ] **Step 1: Update the allowlist pin test (failing first)**

In `apps/api/src/middleware/auth-wall.test.ts`:

```ts
  it("pins the exact anonymous surface of the API", () => {
    expect(AUTH_WALL_ALLOWLIST.prefixes).toEqual(["/auth/", "/public/"]);
    // exact list unchanged
```

And in the `isWallAllowlisted` describe:

```ts
  it("admits the /public/ prefix (anonymous internet-public reads)", () => {
    expect(isWallAllowlisted("/public/entities/abc")).toBe(true);
    expect(isWallAllowlisted("/public/entities/abc/comments/thread")).toBe(true);
  });
```

And extend the near-miss test:

```ts
    expect(isWallAllowlisted("/publicx/anything")).toBe(false);    // prefix must not over-match
    expect(isWallAllowlisted("/public")).toBe(false);              // bare /public is not a route
```

- [ ] **Step 2: Write the failing anonymous-read integration tests**

Append to `apps/api/test/integration/public-read.test.ts`:

```ts
const anon = (path: string) => api("GET", `${base(projectId)}/public${path}`, {});

describe("GET /public/* — anonymous internet-public reads", () => {
  it("serves a public spaceless entity + its comments + thread, with open CORS", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    const c1 = await makeComment(e.id, author.id, { content: "top" });
    await makeComment(e.id, author.id, { content: "reply", parentId: c1.id });

    const ent = await anon(`/entities/${e.id}`);
    expect(ent.status).toBe(200);
    expect(ent.body.id).toBe(e.id);
    expect(ent.body.public).toBe(true);
    expect(ent.body.userReaction).toBeNull();
    expect(ent.headers.get("access-control-allow-origin")).toBe("*");

    const list = await anon(`/entities/${e.id}/comments`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1); // top-level only
    expect(list.body.data[0].content).toBe("top");
    expect(list.body.data[0].userReaction).toBeNull();
    expect(list.body.pagination).toBeTruthy(); // envelope shape itself is pinned by pagination.test.ts

    const thread = await anon(`/entities/${e.id}/comments/thread`);
    expect(thread.status).toBe(200);
    expect(thread.body.data).toHaveLength(1);
    expect(thread.body.data[0].replies).toHaveLength(1);
    expect(thread.body.data[0].replies[0].content).toBe("reply");
  });

  it("serves a public entity in a public space", async () => {
    const s = await makeSpace("anyone");
    const e = await makeEntity({ spaceId: s.id, isPublic: true });
    expect((await anon(`/entities/${e.id}`)).status).toBe(200);
  });

  it("404s all three routes when the flag is off", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: false, userId: author.id });
    for (const p of [`/entities/${e.id}`, `/entities/${e.id}/comments`, `/entities/${e.id}/comments/thread`]) {
      const res = await anon(p);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("entities/not-found");
    }
  });

  it("404s all three routes when the space has gone members-only (live backstop)", async () => {
    const s = await makeSpace("anyone");
    const e = await makeEntity({ spaceId: s.id, isPublic: true });
    await getDb().update(spaces).set({ readingPermission: "members" }).where(eq(spaces.id, s.id));
    for (const p of [`/entities/${e.id}`, `/entities/${e.id}/comments`, `/entities/${e.id}/comments/thread`])
      expect((await anon(p)).status).toBe(404);
  });

  it("404s a draft, a soft-deleted, and a moderation-removed public entity", async () => {
    for (const e of [
      await makeEntity({ isPublic: true, isDraft: true }),
      await makeEntity({ isPublic: true, deletedAt: new Date() }),
      await makeEntity({ isPublic: true, moderationStatus: "removed" }),
    ]) expect((await anon(`/entities/${e.id}`)).status).toBe(404);
  });

  it("404s malformed and unknown ids (no 500s for probes)", async () => {
    expect((await anon(`/entities/not-a-uuid`)).status).toBe(404);
    expect((await anon(`/entities/${randomUUID()}`)).status).toBe(404);
  });

  it("hides removed comments and deleted comments from the public list and thread", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    await makeComment(e.id, author.id, { content: "visible" });
    await makeComment(e.id, author.id, { content: "removed", moderationStatus: "removed" });
    await makeComment(e.id, author.id, { content: "deleted", deletedAt: new Date() });

    const list = await anon(`/entities/${e.id}/comments`);
    expect(list.body.data.map((x: any) => x.content)).toEqual(["visible"]);
    const thread = await anon(`/entities/${e.id}/comments/thread`);
    expect(thread.body.data.map((x: any) => x.content)).toEqual(["visible"]);
  });

  it("keeps the walled surface walled: anonymous GET /entities/:id is still 401", async () => {
    const e = await makeEntity({ isPublic: true });
    expect((await api("GET", `${base(projectId)}/entities/${e.id}`, {})).status).toBe(401);
    expect((await api("GET", `${base(projectId)}/comments?entityId=${e.id}`, {})).status).toBe(401);
  });
});
```

- [ ] **Step 3: Run both to verify failure**

```bash
cd apps/api && pnpm test -- auth-wall
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts public-read
```

Expected: both FAIL (allowlist pin mismatch; /public routes 401/404).

- [ ] **Step 4: Add the allowlist prefix**

In `packages/core/src/middleware/auth.ts`, `AUTH_WALL_ALLOWLIST`:

```ts
  // The door itself: sign-up/sign-in/refresh/reset/verify. Its authed members
  // (change-password, account deletion) keep their inner requireAuth.
  // /public/ is the anonymous internet-public read surface (GET-only; every route re-gates via
  // assertEntityInternetPublic). Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
  prefixes: ["/auth/", "/public/"],
```

- [ ] **Step 5: Create the public router**

Create `apps/api/src/routes/public.ts`:

```ts
// /v7/:projectId/public/* — the anonymous, GET-only internet-public read surface.
// Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
//
// The ONLY project-scoped prefix on AUTH_WALL_ALLOWLIST besides /auth/. Every route re-runs the
// internet-public gate ITSELF (assertEntityInternetPublic) — no route trusts another ran first,
// and nothing here branches on c.var.auth (privileged viewers use the normal walled surface).
// Removed comments are ALWAYS hidden: an anonymous caller is never privileged. 404, never 403.
import { Hono } from "hono";
import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { getDb } from "../db/index.js";
import { comments } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { resolveCommentSort, commentOrderBy } from "../lib/comment-sort.js";
import { markDeprecated } from "../http/deprecation.js";
import { assertEntityInternetPublic } from "../lib/public-access.js";
import { shapeComment, shapeEntity, parseInclude, loadUsers, loadEntityFiles } from "../lib/shape.js";

export const publicRoutes = new Hono<{ Variables: Variables }>()
  // Third-party embed CORS: this surface is anonymous, read-only, and serves only internet-public
  // data — allow any origin, never credentials. Post-next override beats the app-level CORS_ORIGIN.
  .use("*", async (c, next) => {
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
    c.res.headers.delete("Access-Control-Allow-Credentials");
  })
  .get("/entities/:id", async (c) => {
    const projectId = c.var.projectId;
    const row = await assertEntityInternetPublic(projectId, c.req.param("id"));
    const include = parseInclude(c);
    const opts: Parameters<typeof shapeEntity>[1] = {};
    if (include.has("user") && row.userId) {
      const users = await loadUsers(projectId, [row.userId]);
      opts.user = users.get(row.userId) ?? null;
    }
    if (include.has("files")) {
      const fileMap = await loadEntityFiles(projectId, [row.id]);
      opts.files = fileMap.get(row.id) ?? [];
    }
    return c.json(shapeEntity(row, opts));
  })
  // Paginated one-level comment list (mirrors the walled GET /comments?entityId=; parentId pages replies).
  .get("/entities/:id/comments", async (c) => {
    const projectId = c.var.projectId;
    const entityId = c.req.param("id");
    await assertEntityInternetPublic(projectId, entityId);
    const clean = (v: string | undefined) => (v && v !== "null" && v !== "undefined" ? v : undefined);
    const parentId = clean(c.req.query("parentId")) ?? null;
    const { page, limit, offset } = readPagination(c);
    const include = parseInclude(c);

    const conds: SQL[] = [
      eq(comments.projectId, projectId),
      eq(comments.entityId, entityId),
      isNull(comments.deletedAt),
      parentId ? eq(comments.parentId, parentId) : isNull(comments.parentId),
      // Anonymous is never privileged — removed rows are unconditionally hidden.
      sql`${comments.moderationStatus} is distinct from 'removed'`,
    ];
    const where = and(...conds);
    const sort = resolveCommentSort(c.req.query("sortBy"), c.req.query("sortDir"));
    if (sort.deprecated) markDeprecated(c);

    const rows = await getDb().select().from(comments).where(where)
      .orderBy(...commentOrderBy(sort)).limit(limit).offset(offset);
    const totals = await getDb().select({ total: count() }).from(comments).where(where);
    const total = totals[0]?.total ?? 0;

    const userMap = include.has("user") ? await loadUsers(projectId, rows.map((r) => r.userId)) : null;
    const shaped = rows.map((r) => shapeComment(r, {
      userReaction: null,
      ...(userMap ? { user: r.userId ? userMap.get(r.userId) ?? null : null } : {}),
    }));
    return c.json(paginate(shaped, total, page, limit));
  })
  // Full nested subtree (mirrors the walled GET /comments/thread), removed subtrees pruned in-RPC.
  .get("/entities/:id/comments/thread", async (c) => {
    const projectId = c.var.projectId;
    const entityId = c.req.param("id");
    await assertEntityInternetPublic(projectId, entityId);
    const rootRaw = c.req.query("rootId") ?? c.req.query("parentId") ?? null;
    const rootId = rootRaw && /^[0-9a-f-]{36}$/i.test(rootRaw) ? rootRaw : null;
    const { limit, offset } = readPagination(c, { page: 1, limit: 50 });
    const include = parseInclude(c);

    // p_hide_removed is unconditionally TRUE — anon is never privileged.
    const res = (await getDb().execute(sql`
      select id, parent_id, depth from fetch_comment_thread(${entityId}::uuid, ${rootId}::uuid, ${limit}, ${offset}, true)
    `)) as unknown as { id: string; parent_id: string | null; depth: number }[];
    if (res.length === 0) return c.json({ data: [] });

    const ids = res.map((r) => r.id);
    const rows = await getDb().select().from(comments)
      .where(and(eq(comments.projectId, projectId), inArray(comments.id, ids)));
    const userMap = include.has("user") ? await loadUsers(projectId, rows.map((r) => r.userId)) : null;

    type Node = ReturnType<typeof shapeComment> & { replies: Node[] };
    const nodeById = new Map<string, Node>();
    for (const r of rows) {
      const shaped = shapeComment(r, {
        userReaction: null,
        ...(userMap ? { user: r.userId ? userMap.get(r.userId) ?? null : null } : {}),
      });
      nodeById.set(r.id, { ...shaped, replies: [] });
    }
    // RPC rows are ordered by depth then created_at — parents are always seen before children.
    const roots: Node[] = [];
    for (const r of res) {
      const node = nodeById.get(r.id);
      if (!node) continue;
      const parent = r.depth > 0 && r.parent_id ? nodeById.get(r.parent_id) : null;
      (parent ? parent.replies : roots).push(node);
    }
    return c.json({ data: roots });
  });
```

Note: `fetch_comment_thread` also excludes soft-deleted rows' subtrees per the `0019` RPC; the walled thread route relies on the same behavior. If the deleted-comment thread assertion in Step 2 fails because the RPC *returns* deleted rows blanked instead of pruning, adjust that one assertion to expect a blanked (`content: null`) node — mirror whatever the walled `/comments/thread` returns for the same fixture; the invariant that MUST hold is: removed rows never appear.

- [ ] **Step 6: Mount the router**

In `apps/api/src/routes/index.ts`:

```ts
import { publicRoutes } from "./public.js";
```

and after the `project.route("/comments", commentRoutes);` line:

```ts
  // Anonymous internet-public reads (GET-only; the one allowlisted project prefix besides /auth/).
  project.route("/public", publicRoutes);
```

- [ ] **Step 7: Run everything**

```bash
cd apps/api && pnpm test -- auth-wall && pnpm test
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts public-read
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts auth-wall
pnpm -r typecheck
```

Expected: PASS everywhere (the core middleware edit requires `pnpm --filter @agora/core build` first).

- [ ] **Step 8: Commit** *(only if authorized)*

```bash
git add apps/api/src/routes/public.ts apps/api/src/routes/index.ts packages/core/src/middleware/auth.ts apps/api/src/middleware/auth-wall.test.ts apps/api/test/integration/public-read.test.ts
git commit -s -m "feat(api): anonymous /public/* internet-public read surface"
```

---

### Task 6: Docs, changelog, full-suite verification

**Files:**
- Modify: `docs/MANIFEST.md` (new §public + the entities action), `docs/MODELS.md` (Entity `public` field), `CHANGELOG.md` (`[Unreleased]`)

**Interfaces:**
- Consumes: everything above. Produces: nothing code-facing.

- [ ] **Step 1: MANIFEST.md**

Add a `### public (Agora extension)` section (mirror the style of the events/push extension sections — find them with `grep -n "Agora extension" docs/MANIFEST.md`):

```markdown
### public (Agora extension — anonymous internet-public reads)

The only project-scoped prefix on the auth-wall allowlist besides `/auth/`. GET-only, anonymous,
CORS `*`. Every route independently re-derives `entity.public AND space-is-public` (live,
fail-closed) and returns `404 entities/not-found` otherwise — never 403.

| Method | Path | Notes |
|---|---|---|
| GET | `/v7/:projectId/public/entities/:id` | shaped Entity; `?include=user,files` |
| GET | `/v7/:projectId/public/entities/:id/comments` | one-level list, `{ data, pagination }`; `?parentId=&page=&limit=&sortBy=` |
| GET | `/v7/:projectId/public/entities/:id/comments/thread` | nested subtree `{ data }`; `?rootId=&limit=&offset=` |
```

And in the entities section, add the action row:

```markdown
| PATCH | `/v7/:projectId/entities/:id/visibility` | 🔶 Agora ext. Body `{ public: boolean }`. Privileged: operator ‖ project owner/admin ‖ space owner/admin. Ladder: `public:true` requires a community-public entity (400 `entities/not-community-public`); 404-posture for unreadable entities. |
```

- [ ] **Step 2: MODELS.md**

In the Entity model table, after `isDraft`:

```markdown
| `public` | boolean | Internet-visibility flag (Agora extension): `true` ⇒ readable anonymously via `/public/*`. Default `false`. |
```

- [ ] **Step 3: CHANGELOG.md** — under `## [Unreleased]`:

```markdown
### Added
- Internet-public entities (visibility-ladder top rung): privileged `PATCH /entities/:id/visibility`
  (`{ public: boolean }`; operator/project-admin/space-admin only, ladder-validated against the
  space's reading permission) and an anonymous GET-only `/v7/:projectId/public/*` read surface
  (entity + comment list + comment thread) that pierces the auth wall via a single allowlisted
  prefix; every public route re-derives `public AND space-is-public` live and 404s otherwise.
  New `entities.is_public` column (migration `0065`), `Entity.public` contract field.
```

- [ ] **Step 4: Full verification**

```bash
pnpm -r typecheck
cd apps/api && pnpm test
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api test:integration
```

Expected: all PASS. (Integration failures unrelated to this branch: check the merge-base discriminator + dev-.env drift before suspecting the work.)

- [ ] **Step 5: Propagation check**

```bash
pnpm --filter @agora/api check:propagation --diff root
```

Resolve any obligations the checker raises (no env vars or compose services were added, so expect docs-only mirrors). Optionally run `/propagate` for the full assisted sweep.

- [ ] **Step 6: Commit** *(only if authorized)*

```bash
git add docs/MANIFEST.md docs/MODELS.md CHANGELOG.md
git commit -s -m "docs: internet-public entities contract (§public, Entity.public, changelog)"
```
