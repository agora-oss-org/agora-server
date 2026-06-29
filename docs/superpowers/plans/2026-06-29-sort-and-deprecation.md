# Sort & Deprecation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `createdAt` sort to entities and comments, a `controversial` sort to comments, honor `sortDir`, and emit an RFC 8594 `Deprecation` header for the legacy `new`/`old` aliases.

**Architecture:** Decision logic is extracted into pure, unit-tested functions (an entity ranking-registry entry, a comment-sort resolver, and a deprecation helper/predicate). Route handlers stay thin: they call the pure functions and set the header. No schema, no migration.

**Tech Stack:** Hono, Drizzle ORM (`sql`/`asc`/`desc`), zod (contract), vitest (unit, no DB).

## Global Constraints

- Pure/branching logic ships with unit tests in the same change (`src/**/*.test.ts`, vitest, no DB).
- Use the shared `logger` (`lib/logger.ts`), never `console.*`. Not expected to be needed here.
- `pnpm -r typecheck` and `pnpm test` must pass before any task is considered done.
- Run vitest from `apps/api`: `pnpm test -- <pattern>` (name filter).
- Deprecation signal is **RFC 8594 `Deprecation: true`** with **no `Sunset`** (there is no scheduled v8; aliases keep working indefinitely).
- `controversial` for comments reuses the **entity** formula: `min(up,down)` desc, then `sum(up,down)` desc (mirrors `RANKING_ALGORITHMS.controversial` in `lib/ranking.ts`).
- Unknown `sortBy` values are coerced to the default (`createdAt DESC`), **not** rejected with 400 — forward-compatibility for clients; documented deviation from spec §3.5. Deprecated aliases (`new`/`old`) are always accepted.

---

### Task 1: Deprecation helper + entity-sort predicate

**Files:**
- Create: `apps/api/src/http/deprecation.ts`
- Test: `apps/api/src/http/deprecation.test.ts`

**Interfaces:**
- Produces: `markDeprecated(c: Context): void` (sets `Deprecation: true`), `isDeprecatedEntitySort(rawSortBy: string | undefined): boolean` (true only for `"new"`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/http/deprecation.test.ts
import { describe, it, expect, vi } from "vitest";
import { markDeprecated, isDeprecatedEntitySort } from "./deprecation.js";

describe("markDeprecated", () => {
  it("sets the RFC 8594 Deprecation header and no Sunset", () => {
    const header = vi.fn();
    markDeprecated({ header } as any);
    expect(header).toHaveBeenCalledWith("Deprecation", "true");
    expect(header).toHaveBeenCalledTimes(1); // no Sunset
  });
});

describe("isDeprecatedEntitySort", () => {
  it("is true only for the legacy `new` alias", () => {
    expect(isDeprecatedEntitySort("new")).toBe(true);
    expect(isDeprecatedEntitySort("createdAt")).toBe(false);
    expect(isDeprecatedEntitySort("hot")).toBe(false);
    expect(isDeprecatedEntitySort(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- deprecation`
Expected: FAIL — cannot find module `./deprecation.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/http/deprecation.ts
// RFC 8594 deprecation signaling for legacy sort aliases (`new`/`old`). We emit only the
// `Deprecation` header — no `Sunset`, because there is no scheduled removal ("v8") date. The
// aliases keep working; this is the warning, not the removal.
import type { Context } from "hono";

export function markDeprecated(c: Context): void {
  c.header("Deprecation", "true");
}

/** The entity feed's only deprecated sort alias is `new` (→ canonical `createdAt`). */
export function isDeprecatedEntitySort(rawSortBy: string | undefined): boolean {
  return rawSortBy === "new";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- deprecation`
Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/http/deprecation.ts apps/api/src/http/deprecation.test.ts
git commit -m "feat(http): add RFC 8594 deprecation helper for legacy sort aliases"
```

---

### Task 2: First-class `createdAt` entity ranking algorithm

**Files:**
- Modify: `apps/api/src/lib/ranking.ts:69-134` (the `RANKING_ALGORITHMS` registry)
- Test: `apps/api/src/lib/ranking.test.ts:65-76` (the closed-set assertion)

**Interfaces:**
- Produces: `RANKING_ALGORITHMS.createdAt` — query-time algo ordering by `entities.created_at` honoring `dir` (so `sortDir=asc|desc` works), with an `id` tiebreaker. `new` is unchanged (deprecated alias, also chronological).

- [ ] **Step 1: Update the failing test (expected closed set now includes `createdAt`)**

In `apps/api/src/lib/ranking.test.ts`, change the expected array in the test
`"exposes exactly the expected closed set of algorithms"` (currently lines 65-76) to include
`"createdAt"` in sorted position:

```ts
  it("exposes exactly the expected closed set of algorithms", () => {
    expect([...KNOWN_ALGORITHMS].sort()).toEqual([
      "bayesian",
      "controversial",
      "createdAt",
      "decay",
      "gravity",
      "hot",
      "new",
      "top",
      "wilson",
    ]);
  });
```

Add a focused test for the new algo right after that test:

```ts
  it("createdAt orders by createdAt honoring direction, with an id tiebreaker", () => {
    const order = RANKING_ALGORITHMS.createdAt!.order(ctx as any);
    expect(order.length).toBe(2); // createdAt + id tiebreaker
    expect(RANKING_ALGORITHMS.createdAt!.storage).toBe("query-time");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- ranking`
Expected: FAIL — `createdAt` missing from the registry; closed-set assertion mismatch.

- [ ] **Step 3: Add the algorithm**

In `apps/api/src/lib/ranking.ts`, inside `RANKING_ALGORITHMS`, add a `createdAt` entry immediately
above the existing `new` entry (line 78):

```ts
  // Canonical chronological sort (SDK v7.6.2). Honors sortDir (asc|desc); `new` is its deprecated
  // alias. Query-time (createdAt is indexed, but this isn't the denormalized score column).
  createdAt: { storage: "query-time", order: ({ dir }) => [dir(entities.createdAt), desc(entities.id)] },

  new: { storage: "query-time", order: ({ dir }) => [dir(entities.createdAt), desc(entities.id)] },
```

(Leave the existing `new` line as-is — it already behaves chronologically; it stays as the deprecated alias.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- ranking`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/ranking.ts apps/api/src/lib/ranking.test.ts
git commit -m "feat(ranking): add first-class createdAt entity sort"
```

---

### Task 3: Emit the deprecation header on `?sortBy=new` for entities

**Files:**
- Modify: `apps/api/src/routes/entities.ts` (the GET `/` list handler, near line 82-89)

**Interfaces:**
- Consumes: `markDeprecated`, `isDeprecatedEntitySort` from `../http/deprecation.js` (Task 1); `RANKING_ALGORITHMS.createdAt` (Task 2).

- [ ] **Step 1: Add the import**

At the top of `apps/api/src/routes/entities.ts`, add (next to the other `../http/...` imports):

```ts
import { markDeprecated, isDeprecatedEntitySort } from "../http/deprecation.js";
```

- [ ] **Step 2: Emit the header when the client requested `new`**

In the GET `/` handler, immediately after the existing line
`if (!clean(c.req.query("sortBy"))) parsed.sortBy = feedCfg.defaultAlgorithm;` (line 82), add:

```ts
    // Legacy `new` alias → canonical `createdAt`; warn clients per RFC 8594 (no Sunset; see deprecation.ts).
    if (isDeprecatedEntitySort(clean(c.req.query("sortBy")))) markDeprecated(c);
```

- [ ] **Step 3: Typecheck**

Run (from repo root): `pnpm -r typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Manual verification (dev server)**

Start the API (`cd apps/api && pnpm dev`), then:

```bash
curl -sD - "http://localhost:4000/v7/11111111-1111-1111-1111-111111111111/entities?sortBy=new" -o /dev/null | grep -i deprecation
```

Expected: a `deprecation: true` response header. A request with `?sortBy=createdAt` (or no `sortBy`)
must NOT include it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/entities.ts
git commit -m "feat(entities): emit RFC 8594 deprecation header for sortBy=new"
```

---

### Task 4: Comment-sort resolver (`createdAt`/`top`/`controversial`/`new`/`old`)

**Files:**
- Create: `apps/api/src/lib/comment-sort.ts`
- Test: `apps/api/src/lib/comment-sort.test.ts`

**Interfaces:**
- Produces:
  - `resolveCommentSort(sortBy: string | undefined, sortDir: string | undefined): CommentSort` where `type CommentSort = { column: "createdAt" | "top" | "controversial"; dir: "asc" | "desc"; deprecated: boolean }`.
  - `commentOrderBy(sort: CommentSort): SQL[]` — the Drizzle ORDER BY list for the `comments` table.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/comment-sort.test.ts
import { describe, it, expect } from "vitest";
import { resolveCommentSort, commentOrderBy } from "./comment-sort.js";

describe("resolveCommentSort", () => {
  it("createdAt honors sortDir, default desc, not deprecated", () => {
    expect(resolveCommentSort("createdAt", undefined)).toEqual({ column: "createdAt", dir: "desc", deprecated: false });
    expect(resolveCommentSort("createdAt", "asc")).toEqual({ column: "createdAt", dir: "asc", deprecated: false });
    expect(resolveCommentSort("createdAt", "desc")).toEqual({ column: "createdAt", dir: "desc", deprecated: false });
  });

  it("maps the deprecated aliases to createdAt with a fixed direction", () => {
    expect(resolveCommentSort("new", undefined)).toEqual({ column: "createdAt", dir: "desc", deprecated: true });
    expect(resolveCommentSort("old", undefined)).toEqual({ column: "createdAt", dir: "asc", deprecated: true });
    // aliases ignore sortDir
    expect(resolveCommentSort("new", "asc")).toEqual({ column: "createdAt", dir: "desc", deprecated: true });
    expect(resolveCommentSort("old", "desc")).toEqual({ column: "createdAt", dir: "asc", deprecated: true });
  });

  it("top and controversial are always desc and not deprecated", () => {
    expect(resolveCommentSort("top", "asc")).toEqual({ column: "top", dir: "desc", deprecated: false });
    expect(resolveCommentSort("controversial", "asc")).toEqual({ column: "controversial", dir: "desc", deprecated: false });
  });

  it("coerces unknown/absent sortBy to createdAt desc (not deprecated)", () => {
    expect(resolveCommentSort(undefined, undefined)).toEqual({ column: "createdAt", dir: "desc", deprecated: false });
    expect(resolveCommentSort("bogus", undefined)).toEqual({ column: "createdAt", dir: "desc", deprecated: false });
  });
});

describe("commentOrderBy", () => {
  it("returns a non-empty ORDER BY list for every column", () => {
    for (const column of ["createdAt", "top", "controversial"] as const) {
      const order = commentOrderBy({ column, dir: "desc", deprecated: false });
      expect(Array.isArray(order)).toBe(true);
      expect(order.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("createdAt asc vs desc both produce a 2-clause order", () => {
    expect(commentOrderBy({ column: "createdAt", dir: "asc", deprecated: false }).length).toBe(2);
    expect(commentOrderBy({ column: "createdAt", dir: "desc", deprecated: false }).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- comment-sort`
Expected: FAIL — cannot find module `./comment-sort.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/lib/comment-sort.ts
// Comment list sort resolver (SDK CommentsSortByOptions: createdAt | top | controversial | new | old).
// Split into a pure decision (resolveCommentSort) and the Drizzle ORDER BY builder (commentOrderBy) so
// the branching is unit-testable without a DB. `controversial` reuses the entity formula
// (min(up,down) then sum) for one consistent definition across the codebase (see lib/ranking.ts).
import { asc, desc, sql, type SQL } from "drizzle-orm";
import { comments } from "../db/schema/index.js";

export type CommentSort = {
  column: "createdAt" | "top" | "controversial";
  dir: "asc" | "desc";
  deprecated: boolean;
};

export function resolveCommentSort(sortBy: string | undefined, sortDir: string | undefined): CommentSort {
  const dir: "asc" | "desc" = sortDir === "asc" ? "asc" : "desc";
  switch (sortBy) {
    case "top": return { column: "top", dir: "desc", deprecated: false };
    case "controversial": return { column: "controversial", dir: "desc", deprecated: false };
    case "new": return { column: "createdAt", dir: "desc", deprecated: true };
    case "old": return { column: "createdAt", dir: "asc", deprecated: true };
    case "createdAt": return { column: "createdAt", dir, deprecated: false };
    default: return { column: "createdAt", dir: "desc", deprecated: false }; // unknown/absent → canonical default
  }
}

const rc = (k: string): SQL => sql`coalesce((${comments.reactionCounts}->>${k})::int, 0)`;

export function commentOrderBy(sort: CommentSort): SQL[] {
  const dirFn = sort.dir === "asc" ? asc : desc;
  switch (sort.column) {
    case "top":
      return [desc(rc("upvote")), desc(comments.createdAt)];
    case "controversial":
      return [desc(sql`least(${rc("upvote")}, ${rc("downvote")})`), desc(sql`${rc("upvote")} + ${rc("downvote")}`), desc(comments.id)];
    case "createdAt":
    default:
      return [dirFn(comments.createdAt), desc(comments.id)];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- comment-sort`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/comment-sort.ts apps/api/src/lib/comment-sort.test.ts
git commit -m "feat(comments): add createdAt/controversial sort resolver"
```

---

### Task 5: Wire the resolver + deprecation header into the comments list route

**Files:**
- Modify: `apps/api/src/routes/comments.ts:51-56` (the sort block) + imports

**Interfaces:**
- Consumes: `resolveCommentSort`, `commentOrderBy` (Task 4); `markDeprecated` (Task 1).

- [ ] **Step 1: Add imports**

At the top of `apps/api/src/routes/comments.ts`, add:

```ts
import { resolveCommentSort, commentOrderBy } from "../lib/comment-sort.js";
import { markDeprecated } from "../http/deprecation.js";
```

- [ ] **Step 2: Replace the hardcoded sort block**

Replace the existing block (currently lines 51-56):

```ts
    // SDK CommentsSortByOptions: "top" | "new" | "old" (new = newest first, old = oldest first).
    const sortBy = c.req.query("sortBy");
    const order =
      sortBy === "top" ? [desc(sql`coalesce((${comments.reactionCounts}->>'upvote')::int, 0)`), desc(comments.createdAt)]
      : sortBy === "old" ? [asc(comments.createdAt)]
      : [desc(comments.createdAt)]; // "new" (default)
```

with:

```ts
    // SDK CommentsSortByOptions: createdAt | top | controversial | new | old. `new`/`old` are
    // deprecated aliases for createdAt desc/asc (RFC 8594 Deprecation header, no Sunset).
    const sort = resolveCommentSort(c.req.query("sortBy"), c.req.query("sortDir"));
    if (sort.deprecated) markDeprecated(c);
    const order = commentOrderBy(sort);
```

- [ ] **Step 3: Typecheck (and drop now-unused imports if flagged)**

Run (from repo root): `pnpm -r typecheck`
Expected: PASS. If `asc` is now unused in `comments.ts`, remove it from the `drizzle-orm` import line
(line 6) to satisfy `noUnusedLocals`. (`desc` and `sql` are still used elsewhere in the file.)

- [ ] **Step 4: Manual verification (dev server)**

```bash
P=11111111-1111-1111-1111-111111111111
# deprecated alias → header present
curl -sD - "http://localhost:4000/v7/$P/comments?entityId=<SOME_ENTITY_UUID>&sortBy=new" -o /dev/null | grep -i deprecation
# controversial → no header, 200 OK
curl -s "http://localhost:4000/v7/$P/comments?entityId=<SOME_ENTITY_UUID>&sortBy=controversial" | head -c 200
```

Expected: `deprecation: true` for `sortBy=new`/`old`; absent for `createdAt`/`top`/`controversial`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/comments.ts
git commit -m "feat(comments): wire sort resolver + deprecation header into list route"
```

---

### Task 6: Add typed sort enums to the shared contract

**Files:**
- Modify: `packages/contract/src/schemas.ts`
- Test: `apps/api/src/lib/contract-schemas.test.ts` (existing contract-schema test file)

**Interfaces:**
- Produces: `commentSortBySchema`, `entitySortDirSchema` exported from `@agora-server/contract` (typed surface for clients/admin; the routes already coerce at runtime via the resolver, so these are for type-sharing + documentation, not a 400 gate).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/lib/contract-schemas.test.ts`:

```ts
import { commentSortBySchema, sortDirSchema } from "@agora-server/contract";

describe("comment sort schemas", () => {
  it("accepts the documented sortBy values incl. deprecated aliases", () => {
    for (const v of ["createdAt", "top", "controversial", "new", "old"]) {
      expect(commentSortBySchema.safeParse(v).success).toBe(true);
    }
  });
  it("accepts asc/desc for sortDir", () => {
    expect(sortDirSchema.safeParse("asc").success).toBe(true);
    expect(sortDirSchema.safeParse("desc").success).toBe(true);
    expect(sortDirSchema.safeParse("sideways").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- contract-schemas`
Expected: FAIL — `commentSortBySchema`/`sortDirSchema` not exported.

- [ ] **Step 3: Add the schemas**

In `packages/contract/src/schemas.ts`, add:

```ts
// Sort surfaces (SDK v7.6.2). `new`/`old` are deprecated aliases the server still accepts.
export const sortDirSchema = z.enum(["asc", "desc"]);
export const commentSortBySchema = z.enum(["createdAt", "top", "controversial", "new", "old"]);
```

Ensure they are re-exported from the package entrypoint if `schemas.ts` symbols aren't auto-exported —
check `packages/contract/src/index.ts` and add `export * from "./schemas.js";` is already present
(it is, since other schemas are consumed). Then rebuild the contract:

```bash
pnpm --filter @agora-server/contract build
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- contract-schemas`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/schemas.ts
git commit -m "feat(contract): add comment sortBy + sortDir enums"
```

---

### Task 7: Changelog + final verification

**Files:**
- Modify: `CHANGELOG.md` (repo root, `## [Unreleased]`)

- [ ] **Step 1: Add changelog entries**

Under `## [Unreleased]` → `### Added`:

```markdown
- Entity feed: first-class `createdAt` sort (honors `sortDir`); `new` kept as a deprecated alias.
- Comment list: `createdAt` and `controversial` sorts; `sortDir` honored for `createdAt`.
- RFC 8594 `Deprecation` header on `?sortBy=new` (entities) and `?sortBy=new|old` (comments).
- `@agora-server/contract`: `commentSortBySchema` + `sortDirSchema`.
```

- [ ] **Step 2: Full verification**

Run (from repo root):

```bash
pnpm -r build && pnpm -r typecheck && pnpm --filter @agora/api test
```

Expected: build, typecheck, and the full unit suite all PASS.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): sort & deprecation"
```

---

## Self-Review notes

- **Spec coverage:** §3 (comment createdAt/controversial/new/old + sortDir + deprecation) → Tasks 4,5; §4 (entity createdAt + new alias + deprecation) → Tasks 2,3; deprecation mechanism → Task 1; zod enums → Task 6. All covered.
- **Deviation (documented):** unknown `sortBy` coerces to `createdAt DESC` rather than 400 (forward-compat); aliases always accepted. Stated in Global Constraints.
- **`sortDir` on score algos:** ignored (entities already clamp; comment resolver fixes `top`/`controversial` to desc). No 400.
- **Type consistency:** `CommentSort`, `resolveCommentSort`, `commentOrderBy`, `markDeprecated`, `isDeprecatedEntitySort` names are used identically across tasks.
