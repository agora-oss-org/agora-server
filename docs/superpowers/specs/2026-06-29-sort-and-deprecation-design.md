# Spec A — Sort & Deprecation (FEATURE_MIGRATION §3 + §4)

**Date:** 2026-06-29
**Status:** Approved — ready for implementation plan
**Source doc:** `docs/FEATURE_MIGRATION.md` §3 (Comment sorting), §4 (Entity feed sorting)
**Effort:** Small. No schema, no migration. Query-param + ordering + a deprecation-header helper.

---

## 1. Context & current state

The SDK v7.6.2 sync added a first-class `createdAt` sort for both comments and entities, plus a
deprecated `new` (entities) / `new`+`old` (comments) alias, and (for comments) a `controversial`
sort. The server side is **mostly there**:

- **Entities** already have a full ranking registry — `apps/api/src/lib/ranking.ts` defines
  `hot | top | new | controversial | decay | gravity | wilson | bayesian` and `metadata.<field>`;
  `apps/api/src/lib/entity-filters.ts:137-171` (`buildFeedOrder`) routes `sortBy` through it and
  already honors `sortDir` (default `desc`).
- **Comments** are primitive — `apps/api/src/routes/comments.ts:51-56` hardcodes an if-chain
  supporting only `top | new | old`, with **no `sortDir`, no `createdAt`, no `controversial`**.
- **No deprecation-header mechanism** exists anywhere (grep for `Deprecation`/`Sunset`/`X-Deprecated`
  returns nothing).
- Sort params are **not validated** by zod today (`packages/contract/src/schemas.ts` has no sortBy
  enum; routes read raw query strings).

## 2. Goals

1. First-class `createdAt` sort on **entities** and **comments**, with `sortDir` (`asc|desc`,
   default `desc`).
2. `controversial` sort on **comments** (entities already have it).
3. Keep `new` (entities + comments) and `old` (comments) working as **deprecated aliases** for
   `createdAt DESC` / `createdAt ASC`, emitting an RFC 8594 `Deprecation` header.
4. Validate `sortBy`/`sortDir` with zod at the boundary.

**Non-goals:** removing `new`/`old` (deferred indefinitely — there is no v8 date; see §6), changing
any existing entity ranking algorithm, adding `hot` to comments (the SDK never sends it for comments).

## 3. Design

### 3.1 Entities (`lib/ranking.ts`, `lib/entity-filters.ts`)

- Add a `createdAt` algorithm to the registry: `ORDER BY created_at <dir>`, where `<dir>` comes from
  `sortDir` (default `desc`). This is the **canonical** chronological sort.
- `new` becomes an explicit **alias** of `createdAt DESC` (keep its current behavior) and is flagged
  as deprecated so the route can emit the header (see §3.3). `new` ignores `sortDir` (always `DESC`,
  matching the old directional-`new` semantics).
- `sortDir:asc` on score-based algos (`hot`/`top`/`controversial`/`decay`/`gravity`/`wilson`/
  `bayesian`) is **ignored/clamped** (current behavior — document it; do not 400).

### 3.2 Comments (`routes/comments.ts`)

Replace the hardcoded if-chain with a small resolver mapping `sortBy` → ORDER BY:

| `sortBy` | ORDER BY | `sortDir` |
|---|---|---|
| `createdAt` | `created_at` | honored (default `desc`) |
| `new` (deprecated) | `created_at DESC` | ignored |
| `old` (deprecated) | `created_at ASC` | ignored |
| `top` | `coalesce((reaction_counts->>'upvote')::int,0) DESC, created_at DESC` | ignored |
| `controversial` | `min(up,down) DESC, (up+down) DESC` (see §3.4) | ignored |

Default `sortBy` when absent: keep current behavior (`createdAt DESC`, i.e. the old `new` default).
The SDK varies the default by call site (`createdAt` for lists, `top` for the full section) but always
sends `sortBy` explicitly, so the server default only matters for direct callers.

### 3.3 Deprecation header helper (`apps/api/src/http/deprecation.ts`, new)

A tiny helper `markDeprecated(c)` that sets **RFC 8594** headers on the Hono context:

```
Deprecation: true
```

No `Sunset` header (decision §6). Call it from the entity-list handler when `sortBy === "new"` and
from the comment-list handler when `sortBy ∈ {"new","old"}`. Unit-tested in isolation.

### 3.4 `controversial` for comments

**Decision:** reuse the **entity** controversial formula for consistency (one definition in the
codebase): rank by `min(upvotes, downvotes) DESC`, tie-break `sum(upvotes, downvotes) DESC`. Pull
upvote/downvote from `comments.reaction_counts` jsonb (`->>'upvote'`, `->>'downvote'`, cast `::int`,
`coalesce(...,0)`). If the entity logic is factored into a reusable SQL fragment, share it; otherwise
mirror it and note the shared origin in a comment.

### 3.5 Validation (`packages/contract`)

Add zod enums consumed by both routes (re-exported via `apps/api/src/lib/validation.ts`):

- Comment `sortBy`: `z.enum(["createdAt","top","controversial","new","old"])`, optional.
- Entity `sortBy`: validated against the ranking registry keys + `createdAt` + `metadata.<field>`
  (keep the existing registry as source of truth; the zod layer should not duplicate/diverge — prefer
  a `refine` against registry keys over a hardcoded second enum).
- `sortDir`: `z.enum(["asc","desc"]).optional()`.

Reject unknown values per the "reject, don't coerce" principle — **except** continue to accept the
deprecated aliases (they are valid, just deprecated).

## 4. Files touched

- `apps/api/src/lib/ranking.ts` — add `createdAt`; mark `new` deprecated-alias.
- `apps/api/src/lib/entity-filters.ts` — ensure `createdAt`/`sortDir` flow through `buildFeedOrder`.
- `apps/api/src/routes/entities.ts` — emit deprecation header on `new`.
- `apps/api/src/routes/comments.ts` — new sort resolver; emit deprecation header on `new`/`old`.
- `apps/api/src/http/deprecation.ts` — **new** helper.
- `packages/contract/src/schemas.ts` — sortBy/sortDir enums.
- `apps/api/src/lib/validation.ts` — re-export.

## 5. Testing (unit; `src/**/*.test.ts`, no DB)

- Comment sort resolver: each `sortBy` → expected ORDER BY; `sortDir` honored only for `createdAt`.
- `controversial` ordering: synthetic up/down counts produce the expected order; matches the entity
  formula.
- `markDeprecated`: sets `Deprecation: true`, no `Sunset`; fires only for `new`/`old`.
- Zod: valid values pass, unknown values reject, aliases still accepted.

## 6. Decisions (resolved)

- **Deprecation format:** RFC 8594 `Deprecation: true` header.
- **Sunset:** **omit** — there is no scheduled "v8" (the term comes from the SDK's own JSDoc marking
  `new`/`old` for removal in a future SDK major; no date exists). Add `Sunset: <date>` only once v8 is
  actually planned. Aliases keep working indefinitely; this spec builds the *signal*, not the removal.
- **`controversial`:** reuse the entity formula (`min(up,down)`, then `sum`).
- **`sortDir` on score algos:** ignore/clamp, do not 400.

## 7. Open questions

None blocking. (If product later wants a distinct comment-controversy formula, it's a localized
change to §3.4.)
