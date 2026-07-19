# Space-Scoped Stewards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Steward grants scoped to a single space — scoped caseload visibility, scoped case-opened notifications, space-admin-managed benches, and the admin SPA honoring the scope.

**Architecture:** `project_roles` gains a nullable `space_id` (NULL = today's project-wide grant, untouched). Authorization is request-time via a cached `getStewardSpaceIds` resolver + a pure `stewardScopeOf` scope function applied across `routes/steward.ts`; one new boolean JWT claim `spaceSteward` gates the admin SPA tab only. Spec: `docs/superpowers/specs/2026-07-17-space-scoped-stewards-design.md`.

**Tech Stack:** Hono, Drizzle/postgres.js, zod, vitest (unit + real-Postgres integration), React/TanStack Query (admin SPA).

## Global Constraints

- Repo root: `/Users/jenova/projects/jenova-marie/agora-server`. Commands below run from `apps/api` unless stated.
- **Commits require Jenova's per-run authorization** — ask at pre-flight before Task 1 (standing rule: never commit without asking; a prior "commit" authorizes that one commit only).
- Build contract before typechecking api: `pnpm --filter @agora-server/contract build` (or `pnpm -r build`). A fresh worktree needs `pnpm install && pnpm -r build` first or vitest dies on `Cannot find package '@agora/core/lib/env'`.
- Apply migrations with `pnpm db:migrate:run` (NEVER `db:migrate`). New journal `when` MUST exceed the current max `1781934611662`.
- Integration suite: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <file>` — `pnpm test:integration -- <name>` does NOT filter. `mkdir -p "$HOME/.cache/agora-tmp"` once.
- Logging: shared `logger` only; `info`/`error` are message-only; raw `err` objects go on `debug`; Pino arg order is data-object-FIRST (`logger.debug({ err }, "msg")`).
- Out-of-scope single reads return **404, never 403** (no existence leak). Capability failures (no scope at all) are 403.
- Unit suite must not touch a DB (`src/**/*.test.ts`); DB behavior goes in `test/integration/**` (isolated by `project_id`, each test mints its own project).
- Kernel schema lives in `packages/core/src/db/schema/` — edit there, never redefine in api.
- Done-gates for the whole plan: `pnpm -r typecheck`, `pnpm test` (root), the new integration file green, CHANGELOG entry, `pnpm check:propagation --diff root`.

---

### Task 1: Migration — `project_roles.space_id`

**Files:**
- Modify: `packages/core/src/db/schema/steward.ts` (the `projectRoles` table, ~line 1–15 of the file's `projectRoles` block)
- Create: `apps/api/drizzle/0066_space_scoped_stewards.sql`
- Modify: `apps/api/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `projectRoles.spaceId` column (drizzle: `spaceId: uuid("space_id")`), DB constraints `project_roles_unique_project` / `project_roles_unique_space` (partial uniques), `project_roles_space_role_check` (CHECK: only `steward` may be space-scoped), index `project_roles_space_idx`.
- Later tasks rely on: `projectRoles.spaceId` being selectable/insertable via Drizzle.

- [ ] **Step 1: Edit the Drizzle schema**

In `packages/core/src/db/schema/steward.ts`, replace the `projectRoles` definition with (add `uniqueIndex` and `sql` to the existing drizzle imports at the top of the file if not present — `import { sql } from "drizzle-orm"`, `uniqueIndex` from `drizzle-orm/pg-core`):

```ts
export const projectRoles = pgTable("project_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  role: projectRole("role").notNull(),
  // NULL = project-wide grant (owner|admin|steward). Set = a grant scoped to one space — only
  // role='steward' may be scoped (DB CHECK project_roles_space_role_check + app guard).
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
  grantedById: uuid("granted_by_id").references(() => profiles.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Postgres NULLs are distinct, so project-wide and space-scoped uniqueness need separate partial indexes.
  uniqueIndex("project_roles_unique_project").on(t.projectId, t.profileId, t.role).where(sql`${t.spaceId} is null`),
  uniqueIndex("project_roles_unique_space").on(t.projectId, t.profileId, t.role, t.spaceId).where(sql`${t.spaceId} is not null`),
  index("project_roles_lookup_idx").on(t.projectId, t.profileId),
  index("project_roles_space_idx").on(t.projectId, t.spaceId).where(sql`${t.spaceId} is not null`),
]);
```

(`spaces` is already imported/defined in this file — `stewardCases.spaceId` references it.)

- [ ] **Step 2: Hand-author the migration** (drizzle-kit generate is broken in this repo — migrations are hand-authored, idempotent)

Create `apps/api/drizzle/0066_space_scoped_stewards.sql`:

```sql
-- 0066: space-scoped steward grants (spec: docs/superpowers/specs/2026-07-17-space-scoped-stewards-design.md).
-- project_roles.space_id: NULL = project-wide grant (unchanged semantics); set = scoped to one space.
-- Only role='steward' may be space-scoped (CHECK). The old 3-column unique is replaced by a partial
-- pair because Postgres treats NULLs as distinct.
ALTER TABLE "project_roles" ADD COLUMN IF NOT EXISTS "space_id" uuid REFERENCES "spaces"("id") ON DELETE CASCADE;

ALTER TABLE "project_roles" DROP CONSTRAINT IF EXISTS "project_roles_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "project_roles_unique_project"
  ON "project_roles" ("project_id","profile_id","role") WHERE "space_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "project_roles_unique_space"
  ON "project_roles" ("project_id","profile_id","role","space_id") WHERE "space_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "project_roles_space_idx"
  ON "project_roles" ("project_id","space_id") WHERE "space_id" IS NOT NULL;

ALTER TABLE "project_roles" DROP CONSTRAINT IF EXISTS "project_roles_space_role_check";
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_space_role_check"
  CHECK ("space_id" IS NULL OR "role" = 'steward');
```

- [ ] **Step 3: Add the journal entry**

Append to the `entries` array in `apps/api/drizzle/meta/_journal.json` (after the `0064_auth_wall_revoke_public_read` entry; keep `version`/`dialect` fields of the entry identical in shape to the previous entry):

```json
{ "idx": 66, "version": "7", "when": 1784350000000, "tag": "0066_space_scoped_stewards", "breakpoints": true }
```

(`when` 1784350000000 > journal max — required or the migrator strands it. Re-confirm the max at execution time: `python3 -c "import json; print(json.load(open('apps/api/drizzle/meta/_journal.json'))['entries'][-1])"` — as of 2026-07-18 it's idx 65 `0065_entity_internet_public`, when 1784246400000, so 1784350000000 still clears it, but a parked store-marketplace plan ALSO reserves `0066` — whichever of the two executes first keeps 0066; the other renumbers to the next free idx/when at its own execution time.)

- [ ] **Step 4: Build core + apply + verify**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm -r build && cd apps/api && pnpm db:migrate:run
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -c '\d project_roles' | grep -E "space_id|unique_project|unique_space|space_role_check|space_idx"
```
Expected: `space_id | uuid`, both partial unique indexes, the CHECK constraint, and `project_roles_space_idx` all listed.

- [ ] **Step 5: Typecheck + existing unit suite still green**

```bash
pnpm typecheck && pnpm test 2>&1 | tail -3
```
Expected: clean typecheck; all unit tests pass (no behavior touched yet).

- [ ] **Step 6: Commit** (if authorized at pre-flight)

```bash
git add ../../packages/core/src/db/schema/steward.ts drizzle/0066_space_scoped_stewards.sql drizzle/meta/_journal.json
git commit -s -m "feat(steward): migration 0066 — space-scoped steward grants column + constraints"
```

---

### Task 2: `project-roles.ts` grows the space dimension

**Files:**
- Modify: `apps/api/src/lib/project-roles.ts`
- Modify: `apps/api/src/lib/stewards.ts`
- Test: `apps/api/src/lib/project-roles.test.ts` (extend)

**Interfaces:**
- Consumes: `projectRoles.spaceId` (Task 1).
- Produces (exact signatures later tasks call):
  - `getProjectRoles(projectId, profileId)` — unchanged signature, now **project-wide rows only** (`space_id IS NULL`).
  - `getStewardSpaceIds(projectId: string, profileId: string): Promise<Set<string>>` — cached 30s.
  - `grantProjectRole(projectId, profileId, role, grantedById, spaceId?: string): Promise<void>` — throws `Errors.badRequest("roles/space-scope-invalid", …)` when `spaceId` is set with `role !== "steward"`.
  - `revokeProjectRole(projectId, profileId, role, spaceId?: string): Promise<void>`
  - `listRoleGrantees(projectId, role, spaceId?: string): Promise<string[]>`
  - `invalidateProjectRoles(projectId, profileId)` — now clears BOTH caches.
  - `listStewardIds(projectId, spaceId?)` / `grantSteward(projectId, profileId, grantedById, spaceId?)` / `revokeSteward(projectId, profileId, spaceId?)` in `stewards.ts`.

- [ ] **Step 1: Write the failing unit test** — append to `apps/api/src/lib/project-roles.test.ts`:

```ts
describe("grantProjectRole space-scope guard", () => {
  it("throws roles/space-scope-invalid when a non-steward role is space-scoped", async () => {
    const { grantProjectRole } = await import("./project-roles.js");
    for (const role of ["owner", "admin"] as const) {
      await expect(
        grantProjectRole("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", role, "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"),
      ).rejects.toMatchObject({ code: "roles/space-scope-invalid" });
    }
  });
});
```
(The guard must throw BEFORE any DB call — the unit suite has a dummy `DATABASE_URL`, so if the implementation queries first, this test errors instead of failing cleanly.)

- [ ] **Step 2: Run it — verify FAIL**

```bash
pnpm test -- project-roles
```
Expected: FAIL — `grantProjectRole` resolves (inserts) or errors on connection instead of rejecting with the code.

- [ ] **Step 3: Implement in `apps/api/src/lib/project-roles.ts`**

Add `isNull` to the drizzle-orm import. Replace the resolution/mutation section (keep the guard predicates at the top of the file untouched):

```ts
// ── Resolution (cached) ──
const TTL_MS = 30_000;
const cache = new Map<string, { roles: Set<ProjectRole>; at: number }>();
const spaceCache = new Map<string, { ids: Set<string>; at: number }>();
const key = (projectId: string, profileId: string) => `${projectId}:${profileId}`;

/** The set of PROJECT-WIDE roles a profile holds (space_id IS NULL; cached). */
export async function getProjectRoles(projectId: string, profileId: string): Promise<Set<ProjectRole>> {
  const k = key(projectId, profileId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.roles;
  const rows = await getDb().select({ role: projectRoles.role }).from(projectRoles)
    .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.profileId, profileId), isNull(projectRoles.spaceId)));
  const roles = new Set<ProjectRole>(rows.map((r) => r.role as ProjectRole));
  cache.set(k, { roles, at: Date.now() });
  return roles;
}

/** Space ids where the profile holds a SPACE-SCOPED steward grant (cached). */
export async function getStewardSpaceIds(projectId: string, profileId: string): Promise<Set<string>> {
  const k = key(projectId, profileId);
  const hit = spaceCache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  const rows = await getDb().select({ spaceId: projectRoles.spaceId }).from(projectRoles)
    .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.profileId, profileId), eq(projectRoles.role, "steward")));
  const ids = new Set<string>(rows.map((r) => r.spaceId).filter((s): s is string => !!s));
  spaceCache.set(k, { ids, at: Date.now() });
  return ids;
}

export function invalidateProjectRoles(projectId: string, profileId: string): void {
  cache.delete(key(projectId, profileId));
  spaceCache.delete(key(projectId, profileId));
}

/** Grant a role (idempotent). `spaceId` scopes the grant to one space — steward only (app guard
 *  mirrors the DB CHECK; defense-in-depth, both fail closed). */
export async function grantProjectRole(projectId: string, profileId: string, role: ProjectRole, grantedById: string, spaceId?: string): Promise<void> {
  if (spaceId && role !== "steward") throw Errors.badRequest("roles/space-scope-invalid", "Only steward grants can be scoped to a space");
  await getDb().insert(projectRoles).values({ projectId, profileId, role, grantedById, spaceId: spaceId ?? null }).onConflictDoNothing();
  invalidateProjectRoles(projectId, profileId);
}
```

In `revokeProjectRole`, change the signature to `(projectId: string, profileId: string, role: ProjectRole, spaceId?: string)` and in the **non-owner** branch replace the delete's `where` with:

```ts
    await getDb().delete(projectRoles)
      .where(and(
        eq(projectRoles.projectId, projectId), eq(projectRoles.profileId, profileId), eq(projectRoles.role, role),
        spaceId ? eq(projectRoles.spaceId, spaceId) : isNull(projectRoles.spaceId),
      ));
```
(The owner branch is unchanged — owners are never space-scoped, per the CHECK.)

In `listRoleGrantees`, change the signature to `(projectId: string, role: ProjectRole, spaceId?: string)` and the `where` to:

```ts
    .where(and(
      eq(projectRoles.projectId, projectId), eq(projectRoles.role, role),
      spaceId ? eq(projectRoles.spaceId, spaceId) : isNull(projectRoles.spaceId),
    ));
```

- [ ] **Step 4: Thread `spaceId` through `apps/api/src/lib/stewards.ts`** — replace the three delegates (docstrings stay):

```ts
export async function isSteward(projectId: string, profileId: string): Promise<boolean> {
  return (await getProjectRoles(projectId, profileId)).has("steward");
}
export async function grantSteward(projectId: string, profileId: string, grantedById: string, spaceId?: string): Promise<void> {
  await grantProjectRole(projectId, profileId, "steward", grantedById, spaceId);
}
export async function revokeSteward(projectId: string, profileId: string, spaceId?: string): Promise<void> {
  await revokeProjectRole(projectId, profileId, "steward", spaceId);
}
export async function listStewardIds(projectId: string, spaceId?: string): Promise<string[]> {
  return listRoleGrantees(projectId, "steward", spaceId);
}
```

- [ ] **Step 5: Run tests — verify PASS**

```bash
pnpm test -- project-roles && pnpm typecheck
```
Expected: new test passes, all existing project-roles tests pass, clean typecheck.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/lib/project-roles.ts src/lib/stewards.ts src/lib/project-roles.test.ts
git commit -s -m "feat(steward): project_roles space dimension — scoped grant/revoke/list + getStewardSpaceIds"
```

---

### Task 3: Pure scope function `stewardScopeOf`

**Files:**
- Create: `apps/api/src/lib/steward-scope.ts`
- Test: `apps/api/src/lib/steward-scope.test.ts`

**Interfaces:**
- Consumes: `isProjectAdmin(a: AuthContext)` from `./project-roles.js` (pure guard).
- Produces: `type StewardScope = { all: true } | { all: false; spaceIds: Set<string> }` and `stewardScopeOf(a: AuthContext, spaceIds: Set<string>): StewardScope | null` (`null` = no steward access at all).

- [ ] **Step 1: Write the failing test** — create `apps/api/src/lib/steward-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stewardScopeOf } from "./steward-scope.js";
import type { AuthContext } from "../http/context.js";

const auth = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: "u1", projectId: "p1", role: "visitor",
  isOperator: false, isProjectOwner: false, isProjectAdmin: false, isSteward: false,
  isSpaceSteward: false, settingsReadonly: false,
  ...over,
} as AuthContext);

describe("stewardScopeOf", () => {
  it("gives full scope to operator, project owner, project admin, and project-wide steward", () => {
    for (const over of [{ isOperator: true }, { isProjectOwner: true }, { isProjectAdmin: true }, { isSteward: true }]) {
      expect(stewardScopeOf(auth(over), new Set())).toEqual({ all: true });
    }
  });
  it("gives space scope to a holder of space grants only", () => {
    const s = stewardScopeOf(auth(), new Set(["s1", "s2"]));
    expect(s).toEqual({ all: false, spaceIds: new Set(["s1", "s2"]) });
  });
  it("full scope wins even when space grants also exist", () => {
    expect(stewardScopeOf(auth({ isSteward: true }), new Set(["s1"]))).toEqual({ all: true });
  });
  it("returns null for a plain member with no grants", () => {
    expect(stewardScopeOf(auth(), new Set())).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`pnpm test -- steward-scope`) — Expected: FAIL, module not found.

Note: this test references `isSpaceSteward` on `AuthContext`, which doesn't exist until Task 4 — the `as AuthContext` cast keeps it compiling either way; the runtime test is independent of that field.

- [ ] **Step 3: Implement** — create `apps/api/src/lib/steward-scope.ts`:

```ts
// The steward-surface scope decision, pure (unit-tested). Full scope for project admins (operator ‖
// owner ‖ admin fold) and project-wide stewards; space scope for space-scoped grant holders; null =
// no steward access. Route handlers wrap this with the cached getStewardSpaceIds lookup.
import type { AuthContext } from "../http/context.js";
import { isProjectAdmin } from "./project-roles.js";

export type StewardScope = { all: true } | { all: false; spaceIds: Set<string> };

export function stewardScopeOf(a: AuthContext, spaceIds: Set<string>): StewardScope | null {
  if (isProjectAdmin(a) || a.isSteward) return { all: true };
  if (spaceIds.size === 0) return null;
  return { all: false, spaceIds };
}
```

- [ ] **Step 4: Run — verify PASS** (`pnpm test -- steward-scope`) — Expected: 4 passing.

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/lib/steward-scope.ts src/lib/steward-scope.test.ts
git commit -s -m "feat(steward): pure stewardScopeOf scope function"
```

---

### Task 4: The `spaceSteward` claim end-to-end (contract → tokens → middleware → AuthUser)

**Files:**
- Modify: `packages/contract/src/types.ts` (AuthContext ~line 146–157; AuthUser ~line 107–113)
- Modify: `packages/core/src/middleware/auth.ts` (~line 27–30)
- Modify: `apps/api/src/lib/tokens.ts` (signAccessToken ~30, mintSession ~55, profileAuthBits ~133, call sites ~96/111)
- Modify: `apps/api/src/lib/shape.ts` (shapeAuthUser ~319)
- Modify: `apps/api/src/routes/auth.ts` (authBits ~78–83, sessionResponse ~86–93, refresh site ~150–160)
- Modify: `apps/api/test/integration/helpers.ts` (signToken ~40)
- Test: `apps/api/src/lib/shape-extra.test.ts` (extend)

**Interfaces:**
- Produces: JWT claim `spaceSteward: boolean`; `AuthContext.isSpaceSteward: boolean`; `AuthUser.isSpaceSteward: boolean`; `shapeAuthUser(row, suspensions, isOperator, isSteward, isProjectOwner, isProjectAdmin, isSpaceSteward)`; `signToken(userId, role, operator, steward, owner, admin, projectId, settingsReadonly, spaceSteward)` in test helpers.
- Consumes: `getStewardSpaceIds` (Task 2).

- [ ] **Step 1: Write the failing unit test** — append to `apps/api/src/lib/shape-extra.test.ts` inside its shapeAuthUser describe (mirror the existing `row`/`D` fixtures used at line ~55):

```ts
  it("passes the privilege flags through, including isSpaceSteward", () => {
    const u = shapeAuthUser(row, [], true, true, false, false, true);
    expect(u.isOperator).toBe(true);
    expect(u.isSteward).toBe(true);
    expect(u.isSpaceSteward).toBe(true);
    expect(shapeAuthUser(row).isSpaceSteward).toBe(false);
  });
```

- [ ] **Step 2: Run — verify FAIL** (`pnpm test -- shape-extra`) — Expected: FAIL (`isSpaceSteward` undefined / TS error on arity is fine at runtime via vitest transform — the assertion fails).

- [ ] **Step 3: Contract** — in `packages/contract/src/types.ts`:

In `AuthUser` (after the `isSteward` line ~112):
```ts
  // Agora extension: true when this identity holds at least one SPACE-scoped steward grant. UI-gating
  // only (shows the admin Steward tab); real authorization is request-time per space on the server.
  isSpaceSteward: boolean;
```
In `AuthContext` (after its `isSteward` line ~153):
```ts
  isSpaceSteward: boolean; // holds ≥1 space-scoped steward grant — UI gate only, authz is request-time
```
Rebuild: `pnpm --filter @agora-server/contract build`.

- [ ] **Step 4: Core middleware** — in `packages/core/src/middleware/auth.ts`, in the payload→AuthContext mapping (after line 27 `isSteward:`):

```ts
      isSpaceSteward: payload.spaceSteward === true,
```
Then `pnpm --filter @agora/core build`.

- [ ] **Step 5: tokens.ts** — in `apps/api/src/lib/tokens.ts`:

- `signAccessToken`: add trailing param `spaceSteward = false`; add `spaceSteward` to the SignJWT payload object.
- `mintSession`: add trailing param `spaceSteward = false`; pass it as the last arg of its `signAccessToken` call.
- `profileAuthBits`: import `getStewardSpaceIds` from `./project-roles.js`; add `spaceSteward: boolean` to the return type; the empty-profile early return gets `spaceSteward: false`; the main return adds:
```ts
    spaceSteward: (await getStewardSpaceIds(projectId, profileId)).size > 0,
```
- Both call sites (~96–97 and ~111–112): add `spaceSteward` to the destructure and pass it as the new last arg of `mintSession(...)`.

- [ ] **Step 6: shapeAuthUser** — in `apps/api/src/lib/shape.ts`, add param `isSpaceSteward = false` after `isProjectAdmin = false`, and `isSpaceSteward,` to the returned object after `isProjectAdmin,`.

- [ ] **Step 7: routes/auth.ts** — `authBits` (~line 78–83): add to the returned object:
```ts
spaceSteward: (await getStewardSpaceIds(projectId, profile.id)).size > 0,
```
(import `getStewardSpaceIds` from `../lib/project-roles.js`). In `sessionResponse`, add `spaceSteward` to the destructure of the `authBits` result, then pass it through both calls:

```ts
  const { accessToken, refreshToken } = await mintSession(projectId, profile.id, profile.role, operator, steward, owner, admin, settingsReadonly, spaceSteward);
  return { user: shapeAuthUser(profile, suspensions, operator, steward, owner, admin, spaceSteward), accessToken, refreshToken };
```

(`spaceSteward` sits after `settingsReadonly` in `mintSession`, matching the new arity.) At the refresh site (~line 158):

```ts
        ? shapeAuthUser(profile, suspensions, bits.operator, bits.steward, bits.owner, bits.admin, bits.spaceSteward)
```

⚠️ Check `mintSession`'s existing positional order at line ~55 — `settingsReadonly` precedes the optional `familyId`; insert `spaceSteward` after `settingsReadonly`, before `familyId`, and update ALL call sites (grep `mintSession(` project-wide) to keep positions aligned.

- [ ] **Step 8: Integration helper** — in `apps/api/test/integration/helpers.ts`, `signToken` gains a trailing param `spaceSteward = false` and the payload spread `...(spaceSteward ? { spaceSteward: true } : {})`.

- [ ] **Step 9: Verify PASS + full gates**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm -r build && pnpm -r typecheck && cd apps/api && pnpm test 2>&1 | tail -3
```
Expected: clean build/typecheck (the admin SPA typecheck will FAIL if `AuthUser` consumers require the new field — if `apps/admin` errors on missing `isSpaceSteward` handling, that's Task 10's file; add the field usage there only if typecheck demands it, otherwise leave for Task 10). All unit tests pass including the new shape-extra case.

- [ ] **Step 10: Commit** (if authorized)

```bash
git add ../../packages/contract/src/types.ts ../../packages/core/src/middleware/auth.ts src/lib/tokens.ts src/lib/shape.ts src/routes/auth.ts test/integration/helpers.ts src/lib/shape-extra.test.ts
git commit -s -m "feat(steward): spaceSteward JWT claim + isSpaceSteward on AuthContext/AuthUser"
```

---

### Task 5: Scope enforcement — caseload reads (integration TDD)

**Files:**
- Create: `apps/api/test/integration/steward-space-scope.test.ts`
- Modify: `apps/api/src/routes/steward.ts`

**Interfaces:**
- Consumes: `stewardScopeOf`/`StewardScope` (Task 3), `getStewardSpaceIds` + `grantProjectRole` + `invalidateProjectRoles` (Task 2), `signToken` (Task 4).
- Produces: `resolveStewardScope(c): Promise<StewardScope>` (module-local in steward.ts, throws `403 steward/forbidden`), `getCase(projectId, id, scope)` (out-of-scope → `404 steward/case-not-found`). Every case route resolves scope first.

- [ ] **Step 1: Write the failing integration tests** — create `apps/api/test/integration/steward-space-scope.test.ts`:

```ts
// Space-scoped steward: caseload visibility. A space steward sees ONLY their space's cases; out-of-
// scope and project-level cases 404 on single reads (never 403 — no existence leak) and are absent
// from lists. Project-wide stewards/admins are unaffected.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { spaces, spaceMembers, stewardCases } from "../../src/db/schema/index.js";
import { grantProjectRole, invalidateProjectRoles } from "../../src/lib/project-roles.js";

const sid = () => randomUUID().slice(0, 10);

async function makeSpace(projectId: string, name: string): Promise<string> {
  const [s] = await getDb().insert(spaces).values({ projectId, name, shortId: sid() }).returning({ id: spaces.id });
  return s!.id;
}
async function addMember(projectId: string, spaceId: string, userId: string, role: "admin" | "member" = "member") {
  await getDb().insert(spaceMembers).values({ projectId, spaceId, userId, role, status: "active" }).onConflictDoNothing();
}
async function makeCase(projectId: string, spaceId: string | null, openedById: string): Promise<string> {
  const [r] = await getDb().insert(stewardCases).values({ projectId, spaceId, openedById, summary: "t" }).returning({ id: stewardCases.id });
  return r!.id;
}

describe("space-scoped steward: caseload visibility", () => {
  let projectId: string, B: string;
  let spaceA: string, spaceB: string;
  let caseA: string, caseB: string, caseProject: string;
  let stewA: { id: string; token: string };   // space steward of A only
  let projSteward: { id: string; token: string };
  let member: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    const [a, p, m] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    stewA = { id: a.id, token: await signToken(a.id, "visitor", false, false, false, false, projectId) };
    projSteward = { id: p.id, token: await signToken(p.id, "visitor", false, true, false, false, projectId) };
    member = { id: m.id, token: await signToken(m.id, "visitor", false, false, false, false, projectId) };
    spaceA = await makeSpace(projectId, "Alpha");
    spaceB = await makeSpace(projectId, "Beta");
    await addMember(projectId, spaceA, stewA.id);
    await grantProjectRole(projectId, stewA.id, "steward", p.id, spaceA);
    invalidateProjectRoles(projectId, stewA.id);
    caseA = await makeCase(projectId, spaceA, p.id);
    caseB = await makeCase(projectId, spaceB, p.id);
    caseProject = await makeCase(projectId, null, p.id);
  });
  afterAll(async () => { await deleteProject(projectId); });

  it("space steward lists only their space's cases", async () => {
    const res = await api("GET", `${B}/steward/cases`, { token: stewA.token });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(caseA);
    expect(ids).not.toContain(caseB);
    expect(ids).not.toContain(caseProject);
  });

  it("project steward still lists everything", async () => {
    const res = await api("GET", `${B}/steward/cases`, { token: projSteward.token });
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([caseA, caseB, caseProject]));
  });

  it("single-read of an out-of-scope case 404s (never 403)", async () => {
    for (const target of [caseB, caseProject]) {
      const res = await api("GET", `${B}/steward/cases/${target}`, { token: stewA.token });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("steward/case-not-found");
    }
  });

  it("in-scope single read, patch, and note all work for the space steward", async () => {
    expect((await api("GET", `${B}/steward/cases/${caseA}`, { token: stewA.token })).status).toBe(200);
    expect((await api("POST", `${B}/steward/cases/${caseA}/notes`, { token: stewA.token, body: { body: "hi" } })).status).toBe(201);
    expect((await api("PATCH", `${B}/steward/cases/${caseA}`, { token: stewA.token, body: { asymmetry: true } })).status).toBe(200);
  });

  it("out-of-scope patch/notes/channels 404", async () => {
    expect((await api("PATCH", `${B}/steward/cases/${caseB}`, { token: stewA.token, body: { asymmetry: true } })).status).toBe(404);
    expect((await api("POST", `${B}/steward/cases/${caseB}/notes`, { token: stewA.token, body: { body: "x" } })).status).toBe(404);
    expect((await api("GET", `${B}/steward/cases/${caseB}/channels`, { token: stewA.token })).status).toBe(404);
  });

  it("a plain member is still 403 steward/forbidden", async () => {
    const res = await api("GET", `${B}/steward/cases`, { token: member.token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("steward/forbidden");
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts steward-space-scope
```
Expected: the space-steward tests FAIL — today `requireSteward` 403s stewA on everything (no scope concept). The project-steward and plain-member tests pass.

- [ ] **Step 3: Implement in `apps/api/src/routes/steward.ts`**

Imports: add `inArray` to the drizzle-orm import; add `spaces, spaceMembers` to the schema import (used in Tasks 6–8, harmless now); replace the `stewards.js` import line's contents with `listStewardIds, grantSteward, revokeSteward` (unchanged) and extend the project-roles import to `import { isProjectAdmin, requireProjectOwner, getStewardSpaceIds, grantProjectRole, revokeProjectRole } from "../lib/project-roles.js";` plus `import { stewardScopeOf, type StewardScope } from "../lib/steward-scope.js";`

Replace `requireSteward` with:

```ts
// Full scope for project admins/stewards; space scope for space-scoped grant holders; 403 otherwise.
// The pure decision is lib/steward-scope.ts; this wrapper adds the cached grant lookup (skipped when
// the JWT alone already grants full scope).
const NO_SPACES: Set<string> = new Set();
async function resolveStewardScope(c: Ctx): Promise<StewardScope> {
  const a = c.var.auth!;
  const quick = stewardScopeOf(a, NO_SPACES);
  if (quick?.all) return quick;
  const scope = stewardScopeOf(a, await getStewardSpaceIds(c.var.projectId, a.userId));
  if (!scope) throw Errors.forbidden("steward/forbidden", "Steward access required");
  return scope;
}
```

Change `getCase` to take + enforce scope (out-of-scope reads must be indistinguishable from missing — 404):

```ts
async function getCase(projectId: string, id: string, scope: StewardScope): Promise<CaseRow> {
  const [row] = await getDb().select().from(stewardCases)
    .where(and(eq(stewardCases.projectId, projectId), eq(stewardCases.id, id))).limit(1);
  if (!row || (!scope.all && (!row.spaceId || !scope.spaceIds.has(row.spaceId)))) {
    throw Errors.notFound("steward/case-not-found", "Case not found");
  }
  return row;
}
```

In **every** case route, replace `requireSteward(c);` with `const scope = await resolveStewardScope(c);` and pass `scope` to each `getCase(c.var.projectId, …, scope)` call (routes: GET /cases, POST /cases, GET /cases/:id, PATCH /cases/:id, POST /cases/:id/notes, POST /cases/:id/escalate, GET /cases/:id/channels, POST /cases/:id/channels).

In `GET /cases`, after the `conds` array is initialized add:

```ts
    if (!scope.all) conds.push(inArray(stewardCases.spaceId, [...scope.spaceIds]));
```

(POST /cases gets its full scope rules in Task 6 — for now the `resolveStewardScope` swap alone is enough to keep it compiling.)

- [ ] **Step 4: Run — verify PASS**

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts steward-space-scope
```
Expected: all pass. Also run the existing steward suite for regressions:

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts steward
```
Expected: all steward integration files pass. `pnpm typecheck` clean.

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/routes/steward.ts test/integration/steward-space-scope.test.ts
git commit -s -m "feat(steward): scope-enforced caseload reads for space-scoped stewards"
```

---

### Task 6: Scope enforcement — case opening + escalation

**Files:**
- Modify: `apps/api/src/routes/steward.ts`
- Modify: `apps/api/test/integration/steward-space-scope.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveStewardScope`, `getCase(…, scope)` (Task 5).
- Produces: POST /cases scope rules (`403 steward/space-out-of-scope`, `404 steward/report-not-found`); escalate subject-space verification (`409 steward/subject-space-mismatch`); helper `subjectSpaceId(projectId, type, id): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests** — append a describe block to `steward-space-scope.test.ts` (reuses the outer fixtures via a fresh project to keep isolation — copy the same helper functions; also import `entities`, `reports` from the schema and `eq, and` from drizzle-orm):

```ts
describe("space-scoped steward: opening + escalation", () => {
  let projectId: string, B: string;
  let spaceA: string, spaceB: string;
  let stewA: { id: string; token: string };
  let author: { id: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    const [a, au, granter] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    stewA = { id: a.id, token: await signToken(a.id, "visitor", false, false, false, false, projectId) };
    author = { id: au.id };
    spaceA = await makeSpace(projectId, "Alpha");
    spaceB = await makeSpace(projectId, "Beta");
    await addMember(projectId, spaceA, stewA.id);
    await grantProjectRole(projectId, stewA.id, "steward", granter.id, spaceA);
    invalidateProjectRoles(projectId, stewA.id);
  });
  afterAll(async () => { await deleteProject(projectId); });

  async function makeEntity(spaceId: string | null): Promise<string> {
    const [e] = await getDb().insert(entities)
      .values({ projectId, spaceId, userId: author.id, shortId: sid(), title: "subject", content: "c" })
      .returning({ id: entities.id });
    return e!.id;
  }

  it("opens a case in scope; cold-open without a space 403s; out-of-scope space 403s", async () => {
    const ok = await api("POST", `${B}/steward/cases`, { token: stewA.token, body: { spaceId: spaceA, summary: "in scope" } });
    expect(ok.status).toBe(201);
    const noSpace = await api("POST", `${B}/steward/cases`, { token: stewA.token, body: { summary: "project-level" } });
    expect(noSpace.status).toBe(403);
    expect(noSpace.body.code).toBe("steward/space-out-of-scope");
    const wrongSpace = await api("POST", `${B}/steward/cases`, { token: stewA.token, body: { spaceId: spaceB, summary: "nope" } });
    expect(wrongSpace.status).toBe(403);
    expect(wrongSpace.body.code).toBe("steward/space-out-of-scope");
  });

  it("a report outside scope 404s on the report-seeded open path", async () => {
    const entB = await makeEntity(spaceB);
    const [rep] = await getDb().insert(reports)
      .values({ projectId, reporterId: author.id, targetType: "entity", targetId: entB, reason: "spam", spaceId: spaceB })
      .returning({ id: reports.id });
    const res = await api("POST", `${B}/steward/cases`, { token: stewA.token, body: { reportId: rep!.id } });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("steward/report-not-found");
  });

  it("escalates an in-scope case whose subject lives in the case's space", async () => {
    const ent = await makeEntity(spaceA);
    const caseId = (await api("POST", `${B}/steward/cases`, {
      token: stewA.token, body: { spaceId: spaceA, subjectType: "entity", subjectId: ent, summary: "esc" },
    })).body.id;
    const res = await api("POST", `${B}/steward/cases/${caseId}/escalate`, { token: stewA.token, body: {} });
    expect(res.status).toBe(200);
    const [row] = await getDb().select({ m: entities.moderationStatus }).from(entities).where(eq(entities.id, ent));
    expect(row!.m).toBe("removed");
  });

  it("409s escalation when the subject's space mismatches the case's space — content untouched", async () => {
    const entB = await makeEntity(spaceB); // subject lives in B, case claims A
    const [mislabeled] = await getDb().insert(stewardCases)
      .values({ projectId, spaceId: spaceA, subjectType: "entity", subjectId: entB, openedById: stewA.id, summary: "bad" })
      .returning({ id: stewardCases.id });
    const res = await api("POST", `${B}/steward/cases/${mislabeled!.id}/escalate`, { token: stewA.token, body: {} });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("steward/subject-space-mismatch");
    const [row] = await getDb().select({ m: entities.moderationStatus }).from(entities).where(eq(entities.id, entB));
    expect(row!.m).not.toBe("removed");
  });
});
```

(Add `stewardCases`, `entities`, `reports` to the schema import at the top of the file, and `eq` from drizzle-orm.)

- [ ] **Step 2: Run — verify FAIL** (same vitest command as Task 5). Expected: cold-open/wrong-space return 201 today; mismatch escalation removes content (assertion fails).

- [ ] **Step 3: Implement — POST /cases scope rules**

In the POST /cases handler, after the report-seeding `if (reportId) { … }` block and before the insert, add:

```ts
    if (!scope.all) {
      // A scoped steward's report must resolve inside their scope — 404, not 403 (a report they
      // can't act on is a report they can't see; don't leak its existence).
      if (reportId && (!spaceId || !scope.spaceIds.has(spaceId))) {
        throw Errors.notFound("steward/report-not-found", "Report not found");
      }
      // Cold opens must target a space in scope. Uniform code whether the space is missing, foreign,
      // or nonexistent — no existence oracle.
      if (!spaceId || !scope.spaceIds.has(spaceId)) {
        throw Errors.forbidden("steward/space-out-of-scope", "You can only open cases in spaces you steward");
      }
    }
```

- [ ] **Step 4: Implement — escalation subject-space verification**

Add a helper next to `loadSubject` (imports of `conversations` needed: add `conversations` to the schema import):

```ts
// The space a case subject actually lives in: entity → its own spaceId; comment → parent entity's;
// message → its conversation's. Null when unresolvable (deleted parents) — treated as a mismatch by
// the caller (fail closed).
async function subjectSpaceId(projectId: string, type: CaseRow["subjectType"], id: string): Promise<string | null> {
  if (type === "entity") {
    const [e] = await getDb().select({ spaceId: entities.spaceId }).from(entities)
      .where(and(eq(entities.projectId, projectId), eq(entities.id, id))).limit(1);
    return e?.spaceId ?? null;
  }
  if (type === "comment") {
    const [cm] = await getDb().select({ entityId: comments.entityId }).from(comments)
      .where(and(eq(comments.projectId, projectId), eq(comments.id, id))).limit(1);
    if (!cm) return null;
    const [e] = await getDb().select({ spaceId: entities.spaceId }).from(entities)
      .where(and(eq(entities.projectId, projectId), eq(entities.id, cm.entityId))).limit(1);
    return e?.spaceId ?? null;
  }
  const [m] = await getDb().select({ conversationId: chatMessages.conversationId }).from(chatMessages)
    .where(and(eq(chatMessages.projectId, projectId), eq(chatMessages.id, id))).limit(1);
  if (!m) return null;
  const [conv] = await getDb().select({ spaceId: conversations.spaceId }).from(conversations)
    .where(eq(conversations.id, m.conversationId)).limit(1);
  return conv?.spaceId ?? null;
}
```

In the escalate handler, right after the `if (!row.subjectType || !row.subjectId) …` guard:

```ts
    if (!scope.all) {
      const subjSpace = await subjectSpaceId(c.var.projectId, row.subjectType, row.subjectId);
      if (!subjSpace || subjSpace !== row.spaceId) {
        throw Errors.conflict("steward/subject-space-mismatch", "The case subject does not live in the case's space");
      }
    }
```

- [ ] **Step 5: Run — verify PASS** (steward-space-scope + the full steward pattern + `pnpm typecheck`). Expected: all green.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/routes/steward.ts test/integration/steward-space-scope.test.ts
git commit -s -m "feat(steward): scoped case opening + escalation subject-space verification"
```

---

### Task 7: Bench grant endpoints

**Files:**
- Modify: `apps/api/src/routes/steward.ts`
- Modify: `apps/api/test/integration/steward-space-scope.test.ts` (extend)

**Interfaces:**
- Consumes: `grantProjectRole`/`revokeProjectRole` with `spaceId` (Task 2), `listStewardIds(projectId, spaceId)` (Task 2).
- Produces: `GET/POST /steward/spaces/:spaceId/stewards`, `DELETE /steward/spaces/:spaceId/stewards/:userId`. Codes: `404 spaces/not-found` (uniform for invisible/nonexistent/non-admin — no oracle), `400 steward/not-a-member`.

- [ ] **Step 1: Write the failing tests** — append:

```ts
describe("space steward bench management", () => {
  let projectId: string, B: string;
  let space: string, otherSpace: string;
  let spaceAdmin: { id: string; token: string };
  let plainMember: { id: string; token: string };
  let outsider: { id: string; token: string };
  let grantee: { id: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    const [sa, pm, o, g] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId), createUser(projectId)]);
    spaceAdmin = { id: sa.id, token: await signToken(sa.id, "visitor", false, false, false, false, projectId) };
    plainMember = { id: pm.id, token: await signToken(pm.id, "visitor", false, false, false, false, projectId) };
    outsider = { id: o.id, token: await signToken(o.id, "visitor", false, false, false, false, projectId) };
    grantee = { id: g.id };
    space = await makeSpace(projectId, "Bench");
    otherSpace = await makeSpace(projectId, "Elsewhere");
    await addMember(projectId, space, spaceAdmin.id, "admin");
    await addMember(projectId, space, plainMember.id);
    await addMember(projectId, space, grantee.id);
  });
  afterAll(async () => { await deleteProject(projectId); });

  it("space admin grants a member; the bench lists them; revoke removes them", async () => {
    const grant = await api("POST", `${B}/steward/spaces/${space}/stewards`, { token: spaceAdmin.token, body: { userId: grantee.id } });
    expect(grant.status).toBe(201);
    const list = await api("GET", `${B}/steward/spaces/${space}/stewards`, { token: spaceAdmin.token });
    expect(list.body.stewards.map((u: { id: string }) => u.id)).toContain(grantee.id);
    const del = await api("DELETE", `${B}/steward/spaces/${space}/stewards/${grantee.id}`, { token: spaceAdmin.token });
    expect(del.status).toBe(200);
    const after = await api("GET", `${B}/steward/spaces/${space}/stewards`, { token: spaceAdmin.token });
    expect(after.body.stewards.map((u: { id: string }) => u.id)).not.toContain(grantee.id);
  });

  it("a non-member grantee is rejected 400 steward/not-a-member", async () => {
    const res = await api("POST", `${B}/steward/spaces/${space}/stewards`, { token: spaceAdmin.token, body: { userId: outsider.id } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("steward/not-a-member");
  });

  it("plain member and outsider get a uniform 404 (no admin, no oracle)", async () => {
    for (const t of [plainMember.token, outsider.token]) {
      const res = await api("POST", `${B}/steward/spaces/${space}/stewards`, { token: t, body: { userId: grantee.id } });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("spaces/not-found");
    }
  });

  it("an unrelated space's admin cannot manage this bench", async () => {
    await addMember(projectId, otherSpace, plainMember.id, "admin");
    const res = await api("POST", `${B}/steward/spaces/${space}/stewards`, { token: plainMember.token, body: { userId: grantee.id } });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — verify FAIL.** Expected: 404s on all (routes don't exist — Hono unmatched).

- [ ] **Step 3: Implement** — in `steward.ts`, add a gate helper next to `resolveStewardScope`:

```ts
// Bench management gate: project admins (operator ‖ owner ‖ admin fold), the space's owner, or an
// active space-admin member. Everyone else gets a uniform 404 — never 403 — so a private space's
// existence never leaks through the bench endpoints.
async function requireBenchAdmin(c: Ctx, spaceId: string): Promise<void> {
  const a = c.var.auth!;
  const [space] = await getDb().select({ id: spaces.id, userId: spaces.userId }).from(spaces)
    .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, spaceId), isNull(spaces.deletedAt))).limit(1);
  if (space) {
    if (isProjectAdmin(a) || space.userId === a.userId) return;
    const [m] = await getDb().select({ role: spaceMembers.role, status: spaceMembers.status }).from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, a.userId))).limit(1);
    if (m && m.status === "active" && m.role === "admin") return;
  }
  throw Errors.notFound("spaces/not-found", "Space not found");
}
```

Add the routes in the grant-management section (static `/spaces/...` — no conflict with `/cases/:id`); `grantSchema` already exists:

```ts
  // ── Space bench management (space admins / project admins). Elections (phase 3) will write
  //    through the same grantProjectRole seam.
  .get("/spaces/:spaceId/stewards", requireAuth, async (c) => {
    const spaceId = c.req.param("spaceId");
    await requireBenchAdmin(c, spaceId);
    const ids = await listStewardIds(c.var.projectId, spaceId);
    const users = await loadUsers(c.var.projectId, ids);
    return c.json({ stewards: ids.map((id) => users.get(id)).filter(Boolean) });
  })
  .post("/spaces/:spaceId/stewards", requireAuth, async (c) => {
    const spaceId = c.req.param("spaceId");
    await requireBenchAdmin(c, spaceId);
    const body = parseBody(grantSchema, await c.req.json().catch(() => ({})), "steward");
    // The grantee must be an active member (or the space owner): every space steward is a member.
    const [space] = await getDb().select({ userId: spaces.userId }).from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, spaceId))).limit(1);
    if (space?.userId !== body.userId) {
      const [m] = await getDb().select({ status: spaceMembers.status }).from(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, body.userId))).limit(1);
      if (!m || m.status !== "active") throw Errors.badRequest("steward/not-a-member", "The grantee must be an active member of the space");
    }
    await grantProjectRole(c.var.projectId, body.userId, "steward", c.var.auth!.userId, spaceId);
    logger.info({ projectId: c.var.projectId, spaceId, profileId: body.userId, grantedBy: c.var.auth!.userId }, "steward: space grant added");
    return c.json({ success: true }, 201);
  })
  .delete("/spaces/:spaceId/stewards/:userId", requireAuth, async (c) => {
    const spaceId = c.req.param("spaceId");
    await requireBenchAdmin(c, spaceId);
    await revokeProjectRole(c.var.projectId, c.req.param("userId"), "steward", spaceId);
    logger.info({ projectId: c.var.projectId, spaceId, profileId: c.req.param("userId"), revokedBy: c.var.auth!.userId }, "steward: space grant revoked");
    return c.json({ success: true });
  })
```

(`isNull` is already imported in steward.ts; verify `loadUsers`, `logger`, `parseBody` are — they are, per the existing imports.)

- [ ] **Step 4: Run — verify PASS** (+ `pnpm typecheck`).

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/routes/steward.ts test/integration/steward-space-scope.test.ts
git commit -s -m "feat(steward): space bench grant endpoints (space-admin managed)"
```

---

### Task 8: Auto-revoke on membership end

**Files:**
- Modify: `apps/api/src/routes/spaces.ts` (leave handler ~line 319, member-removal handler ~line 383)
- Modify: `apps/api/test/integration/steward-space-scope.test.ts` (extend)

**Interfaces:**
- Consumes: `projectRoles` schema, `invalidateProjectRoles` (Task 2).
- Produces: leaving/being-removed from a space deletes that space's steward grant in the same transaction.

- [ ] **Step 1: Write the failing tests** — append (import `projectRoles` in the schema import of the test file):

```ts
describe("space steward auto-revoke on membership end", () => {
  let projectId: string, B: string;
  let space: string;
  let admin: { id: string; token: string };
  let stew: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    const [a, s] = await Promise.all([createUser(projectId), createUser(projectId)]);
    admin = { id: a.id, token: await signToken(a.id, "visitor", false, false, false, false, projectId) };
    stew = { id: s.id, token: await signToken(s.id, "visitor", false, false, false, false, projectId) };
    space = await makeSpace(projectId, "Revocable");
    await addMember(projectId, space, admin.id, "admin");
  });
  afterAll(async () => { await deleteProject(projectId); });

  async function grantViaBench() {
    await addMember(projectId, space, stew.id);
    const res = await api("POST", `${B}/steward/spaces/${space}/stewards`, { token: admin.token, body: { userId: stew.id } });
    expect(res.status).toBe(201);
  }
  async function grantRows(): Promise<number> {
    const rows = await getDb().select({ id: projectRoles.id }).from(projectRoles)
      .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.profileId, stew.id), eq(projectRoles.role, "steward")));
    return rows.length;
  }

  it("leaving the space strips the grant and caseload access", async () => {
    await grantViaBench();
    expect((await api("GET", `${B}/steward/cases`, { token: stew.token })).status).toBe(200);
    expect((await api("DELETE", `${B}/spaces/${space}/leave`, { token: stew.token })).status).toBe(200);
    expect(await grantRows()).toBe(0);
    expect((await api("GET", `${B}/steward/cases`, { token: stew.token })).status).toBe(403);
  });

  it("being removed by an admin strips the grant too", async () => {
    await grantViaBench();
    expect((await api("DELETE", `${B}/spaces/${space}/members/${stew.id}`, { token: admin.token })).status).toBe(200);
    expect(await grantRows()).toBe(0);
  });
});
```

(Also import `and, eq` from drizzle-orm at the top if not already.)

- [ ] **Step 2: Run — verify FAIL.** Expected: `grantRows()` returns 1 after leave/removal; the post-leave caseload request still 200s.

- [ ] **Step 3: Implement** — in `apps/api/src/routes/spaces.ts`, add to the imports: `projectRoles` in the schema import and `invalidateProjectRoles` from `../lib/project-roles.js` (the file already imports `isProjectAdmin` from there — extend that line).

Replace the leave handler (line ~319):

```ts
  .delete("/:id/leave", requireAuth, async (c) => {
    const uid = c.var.auth!.userId;
    const spaceId = c.req.param("id");
    // Ending a membership ends any space-steward grant with it, atomically: every space steward is a
    // member (spec invariant), so the two rows live and die together.
    await getDb().transaction(async (tx) => {
      await tx.delete(spaceMembers).where(and(
        eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, uid),
      ));
      await tx.delete(projectRoles).where(and(
        eq(projectRoles.projectId, c.var.projectId), eq(projectRoles.profileId, uid),
        eq(projectRoles.role, "steward"), eq(projectRoles.spaceId, spaceId),
      ));
    });
    invalidateProjectRoles(c.var.projectId, uid);
    return c.json({ message: "left" });
  })
```

Replace the member-removal handler (line ~383):

```ts
  .delete("/:id/members/:memberId", requireAuth, async (c) => {
    const space = await getSpace(c);
    await requireSpaceRole(c, space, ["admin", "moderator"]);
    const memberId = c.req.param("memberId");
    await getDb().transaction(async (tx) => {
      await tx.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, memberId)));
      await tx.delete(projectRoles).where(and(
        eq(projectRoles.projectId, c.var.projectId), eq(projectRoles.profileId, memberId),
        eq(projectRoles.role, "steward"), eq(projectRoles.spaceId, space.id),
      ));
    });
    invalidateProjectRoles(c.var.projectId, memberId);
    return c.json({ success: true });
  })
```

- [ ] **Step 4: Run — verify PASS** (steward-space-scope + the spaces integration files + `pnpm typecheck`):

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts steward-space-scope spaces
```

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/routes/spaces.ts test/integration/steward-space-scope.test.ts
git commit -s -m "feat(steward): auto-revoke space steward grant when membership ends"
```

---

### Task 9: Bench notifications on case open

**Files:**
- Modify: `apps/api/src/lib/notifications.ts` (steward section, ~line 365–436)
- Modify: `apps/api/src/routes/steward.ts` (POST /cases notify call, ~line 162)
- Test: `apps/api/src/lib/steward-notify.test.ts` (extend) + `apps/api/test/integration/steward-space-scope.test.ts` (extend)

**Interfaces:**
- Consumes: `listStewardIds(projectId, spaceId)` (Task 2).
- Produces: `stewardBenchRecipients(kind: StewardCaseKind, ctx: StewardCaseCtx & { spaceId?: string | null; actorId: string }, benchIds: string[]): StewardNote[]` (exported, pure); `StewardCaseCtx` gains `spaceId?: string | null`; `notifyStewardCaseEvent` fans out to the bench on `opened`.

- [ ] **Step 1: Write the failing unit test** — append to `apps/api/src/lib/steward-notify.test.ts`:

```ts
import { stewardBenchRecipients } from "./notifications.js";

describe("stewardBenchRecipients", () => {
  const ctx = { caseId: "c1", spaceId: "s1", actorId: "actor", complainantId: "comp", respondentId: "resp" };

  it("notifies the bench on opened, excluding actor and both parties, PII-free metadata", () => {
    const notes = stewardBenchRecipients("opened", ctx, ["b1", "actor", "comp", "resp", "b2"]);
    expect(notes.map((n) => n.recipientId)).toEqual(["b1", "b2"]);
    for (const n of notes) {
      expect(n.type).toBe("steward-case-opened");
      expect(n.action).toBe("steward-case");
      expect(n.metadata).toEqual({ caseId: "c1", spaceId: "s1" }); // no party identity
    }
  });

  it("is silent for non-opened kinds and for space-less cases", () => {
    expect(stewardBenchRecipients("closed", ctx, ["b1"])).toEqual([]);
    expect(stewardBenchRecipients("opened", { ...ctx, spaceId: null }, ["b1"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify FAIL** (`pnpm test -- steward-notify`). Expected: export missing.

- [ ] **Step 3: Implement** — in `notifications.ts`:

Add `spaceId?: string | null;` to `StewardCaseCtx`. Below `stewardCaseRecipients`, add:

```ts
/**
 * Pure bench fan-out rule (unit-tested): when a case OPENS in a space, that space's stewards are told —
 * minus the actor and both parties (a party who also stewards must not get a bench copy of their own
 * case). Metadata is PII-free: caseId + spaceId only, never a party identity.
 */
export function stewardBenchRecipients(
  kind: StewardCaseKind,
  ctx: StewardCaseCtx & { actorId: string },
  benchIds: string[],
): StewardNote[] {
  if (kind !== "opened" || !ctx.spaceId) return [];
  const excluded = new Set([ctx.actorId, ctx.complainantId, ctx.respondentId].filter(Boolean));
  return benchIds.filter((id) => !excluded.has(id)).map((id) => ({
    recipientId: id, type: "steward-case-opened", action: "steward-case",
    metadata: { caseId: ctx.caseId, spaceId: ctx.spaceId },
  }));
}
```

In `notifyStewardCaseEvent`, after the existing `for (const n of notes) …` loop (inside the try), add (import `listStewardIds` from `./stewards.js` at the top of the file):

```ts
    if (args.kind === "opened" && args.spaceId) {
      const bench = await listStewardIds(projectId, args.spaceId);
      for (const n of stewardBenchRecipients(args.kind, args, bench)) {
        await insert(projectId, n.recipientId, args.actorId, n.type, n.action, n.metadata);
      }
    }
```

In `routes/steward.ts` POST /cases, add `spaceId: row!.spaceId,` to the `notifyStewardCaseEvent` args object.

⚠️ Check for an import cycle: `notifications.ts` → `stewards.js` → `project-roles.js`. `project-roles.ts` does not import notifications, so no cycle.

- [ ] **Step 4: Write the failing integration test** — append to `steward-space-scope.test.ts` (import `notifications` from the schema — check `test/integration/notifications.test.ts` for the exact exported table symbol if it differs):

```ts
describe("bench notification on case open", () => {
  let projectId: string, B: string;
  let spaceA: string, spaceB: string;
  let opener: { id: string; token: string };
  let benchA: { id: string }, benchB: { id: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    const [o, a, b] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    opener = { id: o.id, token: await signToken(o.id, "visitor", false, true, false, false, projectId) }; // project steward
    benchA = { id: a.id }; benchB = { id: b.id };
    spaceA = await makeSpace(projectId, "NotifyA");
    spaceB = await makeSpace(projectId, "NotifyB");
    await addMember(projectId, spaceA, benchA.id);
    await addMember(projectId, spaceB, benchB.id);
    await grantProjectRole(projectId, benchA.id, "steward", o.id, spaceA);
    await grantProjectRole(projectId, benchB.id, "steward", o.id, spaceB);
    invalidateProjectRoles(projectId, benchA.id);
    invalidateProjectRoles(projectId, benchB.id);
  });
  afterAll(async () => { await deleteProject(projectId); });

  it("notifies space A's bench and not space B's; metadata is PII-free", async () => {
    const res = await api("POST", `${B}/steward/cases`, { token: opener.token, body: { spaceId: spaceA, summary: "notify" } });
    expect(res.status).toBe(201);
    const rows = await getDb().select().from(notifications)
      .where(and(eq(notifications.projectId, projectId), eq(notifications.type, "steward-case-opened")));
    const recipients = rows.map((r) => r.recipientId);
    expect(recipients).toContain(benchA.id);
    expect(recipients).not.toContain(benchB.id);
    const mine = rows.find((r) => r.recipientId === benchA.id)!;
    expect(mine.metadata).toMatchObject({ caseId: res.body.id, spaceId: spaceA });
    expect(JSON.stringify(mine.metadata)).not.toContain(opener.id);
  });
});
```

- [ ] **Step 5: Run both — verify unit FAIL→PASS already done in 2–3; integration now PASS**

```bash
pnpm test -- steward-notify
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts steward-space-scope
```
Expected: all green. Also `pnpm test` (whole unit suite) — the existing `stewardCaseRecipients` matrix must be untouched.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/lib/notifications.ts src/lib/steward-notify.test.ts src/routes/steward.ts test/integration/steward-space-scope.test.ts
git commit -s -m "feat(steward): scoped bench notifications when a case opens in a space"
```

---

### Task 10: `GET /steward/scope`

**Files:**
- Modify: `apps/api/src/routes/steward.ts`
- Modify: `apps/api/test/integration/steward-space-scope.test.ts` (extend)

**Interfaces:**
- Produces: `GET /steward/scope` → `{ all: true }` or `{ all: false, spaces: [{ id, name }] }`; 403 `steward/forbidden` for non-stewards. The admin SPA consumes this (Task 11).

- [ ] **Step 1: Write the failing test** — append to the FIRST describe block of `steward-space-scope.test.ts` (it already has stewA/projSteward/member):

```ts
  it("GET /steward/scope: full for project steward, scoped+named for space steward, 403 for member", async () => {
    expect((await api("GET", `${B}/steward/scope`, { token: projSteward.token })).body).toEqual({ all: true });
    const scoped = await api("GET", `${B}/steward/scope`, { token: stewA.token });
    expect(scoped.body.all).toBe(false);
    expect(scoped.body.spaces).toEqual([{ id: spaceA, name: "Alpha" }]);
    expect((await api("GET", `${B}/steward/scope`, { token: member.token })).status).toBe(403);
  });
```

- [ ] **Step 2: Run — verify FAIL** (404 unmatched route).

- [ ] **Step 3: Implement** — add to `steward.ts` ABOVE the `/cases/:id` routes is not required (different static prefix), but keep it grouped with the caseload routes:

```ts
  // ── The caller's steward scope, for honest UI labeling (the SPA's "Scoped to: …" banner).
  .get("/scope", requireAuth, async (c) => {
    const scope = await resolveStewardScope(c);
    if (scope.all) return c.json({ all: true });
    const rows = await getDb().select({ id: spaces.id, name: spaces.name }).from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), inArray(spaces.id, [...scope.spaceIds]), isNull(spaces.deletedAt)));
    return c.json({ all: false, spaces: rows });
  })
```

- [ ] **Step 4: Run — verify PASS** (+ typecheck).

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/routes/steward.ts test/integration/steward-space-scope.test.ts
git commit -s -m "feat(steward): GET /steward/scope for scoped-UI labeling"
```

---

### Task 11: Admin SPA — tab gating, scope banner, bench UI

**Files:**
- Modify: `apps/admin/src/auth/AuthContext.tsx` (~line 18/36)
- Modify: `apps/admin/src/components/layout/Sidebar.tsx` (~line 36)
- Modify: `apps/admin/src/lib/steward.ts` (append)
- Modify: `apps/admin/src/routes/StewardPage.tsx` (banner under the PageHeader)
- Create: `apps/admin/src/routes/spaces/SpaceStewards.tsx`
- Modify: `apps/admin/src/routes/SpacesPage.tsx` (`SpaceDetail`, ~line 138 — render the bench section)

**Interfaces:**
- Consumes: `AuthUser.isSpaceSteward` (Task 4), `GET /steward/scope` (Task 10), bench endpoints (Task 7).
- Produces: `useAuth().isSpaceSteward`; `getStewardScope`/`stewardScopeKey`, `getSpaceStewards`/`addSpaceSteward`/`removeSpaceSteward`/`spaceStewardsKey` in `lib/steward.ts`; `<SpaceStewards spaceId />` component.

No test framework exists in `apps/admin` beyond a few lib tests — the gate here is `pnpm -r typecheck` plus a manual smoke note.

- [ ] **Step 1: AuthContext** — in `apps/admin/src/auth/AuthContext.tsx`: add `isSpaceSteward: boolean;` to `AuthValue` (after `isSteward`), and in the memo value:

```ts
      isSpaceSteward: !!session?.user?.isSpaceSteward,
```

- [ ] **Step 2: Sidebar** — in `apps/admin/src/components/layout/Sidebar.tsx`, add `isSpaceSteward` to the `useAuth()` destructure and change line ~36 to:

```ts
          (item.stewardOnly ? isSteward || isProjectAdmin || isSpaceSteward : true),
```

- [ ] **Step 3: Data layer** — append to `apps/admin/src/lib/steward.ts` (it already imports `api`; add `User` to its `@agora-server/contract` type import):

```ts
// ── Space-scoped stewardship (spec 2026-07-17) ──
export interface StewardScopeResponse { all: boolean; spaces?: { id: string; name: string }[] }
export const stewardScopeKey = ["steward", "scope"] as const;
export function getStewardScope() { return api<StewardScopeResponse>(`/steward/scope`); }

export const spaceStewardsKey = (spaceId: string) => ["steward", "space-stewards", spaceId] as const;
export function getSpaceStewards(spaceId: string) { return api<{ stewards: User[] }>(`/steward/spaces/${spaceId}/stewards`); }
export function addSpaceSteward(spaceId: string, userId: string) { return api<{ success: true }>(`/steward/spaces/${spaceId}/stewards`, { method: "POST", body: { userId } }); }
export function removeSpaceSteward(spaceId: string, userId: string) { return api<{ success: true }>(`/steward/spaces/${spaceId}/stewards/${userId}`, { method: "DELETE" }); }
```

- [ ] **Step 4: Scope banner** — in `StewardPage.tsx`, add imports `import { getStewardScope, stewardScopeKey } from "../lib/steward";` (merge into the existing `../lib/steward` import) and inside the page component:

```ts
  const scope = useQuery({ queryKey: stewardScopeKey, queryFn: getStewardScope });
```

Immediately after the `<PageHeader …/>` element in the returned JSX, insert:

```tsx
      {scope.data && !scope.data.all && (
        <Card className="mb-4 px-4 py-2 text-sm text-muted-foreground">
          Scoped to: {scope.data.spaces?.map((s) => s.name).join(", ") || "—"}
        </Card>
      )}
```

(`Card` is already imported in StewardPage.tsx. If the local `Card` has no `className` pass-through, wrap in a `<div className="mb-4">` instead — follow the component's actual prop surface.)

- [ ] **Step 5: Bench section** — create `apps/admin/src/routes/spaces/SpaceStewards.tsx`:

```tsx
// Space bench management: list/grant/revoke this space's stewards. Server-gated (space admin /
// project admin); the section renders for any viewer who can open the space detail — a 404 from the
// bench endpoints just means "not yours to manage", so we hide on error.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addSpaceSteward, getSpaceStewards, removeSpaceSteward, spaceStewardsKey } from "../../lib/steward";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useToast } from "../../components/ui/Toast";

export function SpaceStewards({ spaceId }: { spaceId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [userId, setUserId] = useState("");
  const { data, isError } = useQuery({ queryKey: spaceStewardsKey(spaceId), queryFn: () => getSpaceStewards(spaceId), retry: false });
  const invalidate = () => qc.invalidateQueries({ queryKey: spaceStewardsKey(spaceId) });
  const grant = useMutation({
    mutationFn: () => addSpaceSteward(spaceId, userId.trim()),
    onSuccess: () => { setUserId(""); invalidate(); toast({ title: "Steward granted" }); },
    onError: (e: Error) => toast({ title: "Grant failed", description: e.message }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => removeSpaceSteward(spaceId, id),
    onSuccess: () => { invalidate(); toast({ title: "Steward revoked" }); },
    onError: (e: Error) => toast({ title: "Revoke failed", description: e.message }),
  });

  if (isError) return null; // not a bench admin for this space — the server said 404
  return (
    <Card>
      <h3 className="mb-2 font-medium">Stewards</h3>
      <ul className="mb-3 space-y-1">
        {(data?.stewards ?? []).map((u) => (
          <li key={u.id} className="flex items-center justify-between text-sm">
            <span>{u.username ?? u.id}</span>
            <Button variant="ghost" size="sm" onClick={() => revoke.mutate(u.id)} disabled={revoke.isPending}>Revoke</Button>
          </li>
        ))}
        {data && data.stewards.length === 0 && <li className="text-sm text-muted-foreground">No stewards yet.</li>}
      </ul>
      <div className="flex gap-2">
        <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Member profile id (uuid)" />
        <Button onClick={() => grant.mutate()} disabled={!userId.trim() || grant.isPending}>Grant</Button>
      </div>
    </Card>
  );
}
```

(Match the actual `Button`/`Input`/`useToast` prop surfaces to their definitions in `components/ui/` — mirror how `StewardPage.tsx` calls them; adjust `variant`/`size`/`toast` args to whatever those components actually accept.)

- [ ] **Step 6: Mount it** — in `SpacesPage.tsx`'s `SpaceDetail` (line ~138), import `{ SpaceStewards } from "./spaces/SpaceStewards";` and render `<SpaceStewards spaceId={space.id} />` at the end of the detail layout (inside its outermost container, after the existing sections).

- [ ] **Step 7: Typecheck the workspace**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm -r typecheck
```
Expected: clean. Manual smoke (optional, server running): sign in as a space-steward account → Steward tab visible with the scope banner; as a space admin → Stewards card on the space detail.

- [ ] **Step 8: Commit** (if authorized)

```bash
git add apps/admin/src/auth/AuthContext.tsx apps/admin/src/components/layout/Sidebar.tsx apps/admin/src/lib/steward.ts apps/admin/src/routes/StewardPage.tsx apps/admin/src/routes/spaces/SpaceStewards.tsx apps/admin/src/routes/SpacesPage.tsx
git commit -s -m "feat(admin): space-steward tab gating, scope banner, bench management UI"
```

---

### Task 12: Docs, CHANGELOG, propagation, full gates

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `docs/MANIFEST.md` (steward section: the three bench endpoints + `/steward/scope`), `docs/MODELS.md` (`AuthUser.isSpaceSteward`)
- Modify: `CLAUDE.md` (the **Stewards** paragraph: mention space-scoped grants)
- Checker-driven: whatever `pnpm check:propagation --diff root` flags

- [ ] **Step 1: CHANGELOG** — add under `## [Unreleased]`:

```markdown
### Added
- **Space-scoped stewards.** A steward grant can now be scoped to a single space
  (`project_roles.space_id`, migration 0066): space stewards see only their space's caseload
  (out-of-scope cases 404), open/escalate cases only in scope (escalation verifies the subject
  content actually lives in the case's space — 409 `steward/subject-space-mismatch`), and are
  notified (`steward-case-opened`, PII-free) when a case opens in their space. Benches are managed
  by space admins via `GET/POST/DELETE /v7/:projectId/steward/spaces/:spaceId/stewards` (grantee
  must be an active member — `400 steward/not-a-member`; grants auto-revoke when the membership
  ends). New `GET /steward/scope` + `spaceSteward` JWT claim / `AuthUser.isSpaceSteward` power the
  admin app's scoped Steward tab and per-space bench UI. Project-wide steward behavior is unchanged.
```

- [ ] **Step 2: MANIFEST/MODELS/CLAUDE.md** — document the four new endpoints (methods, paths, gates, error codes exactly as implemented in Tasks 7/10) in MANIFEST's steward section; add `isSpaceSteward: boolean` to AuthUser in MODELS.md; append one sentence to CLAUDE.md's Stewards paragraph: grants may be space-scoped (`project_roles.space_id`), scoped stewards see only their space's cases, benches are space-admin-managed.

- [ ] **Step 3: Propagation check**

```bash
cd apps/api && pnpm check:propagation --diff root
```
Fix anything it flags (env examples/compose are untouched by this feature, so expect docs-only obligations).

- [ ] **Step 4: Full gates**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm -r build && pnpm -r typecheck && cd apps/api && pnpm test 2>&1 | tail -3
TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration 2>&1 | tail -5
```
Expected: everything green. (Integration full-suite: watch for the known unrelated `ENOSPC`/env-drift gotchas — `TMPDIR` redirect is mandatory; if unrelated failures appear, verify against a merge-base run before suspecting this branch.)

- [ ] **Step 5: Commit** (if authorized)

```bash
git add CHANGELOG.md docs/MANIFEST.md docs/MODELS.md CLAUDE.md
git commit -s -m "docs(steward): space-scoped stewards — changelog, manifest, models"
```
