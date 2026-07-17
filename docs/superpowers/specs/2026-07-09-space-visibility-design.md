# Space-Visibility Discovery Filtering — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorm), pending implementation plan
**Scope:** `apps/api` — enforce the space `visibility` axis on discovery surfaces.

## Problem

Spaces carry two orthogonal access axes:

- **`readingPermission`** (`anyone` | `members`) — gates the **content** inside a space
  (entities/comments). Already enforced server-side in `lib/space-access.ts`.
- **`visibility`** (`public` | `unlisted` | `private`, enum `space_visibility`, migration `0060`) —
  gates **discovery of the space row itself** (does it appear in listings; can it be fetched by id/slug).
  Currently **persist + emit only** — the column is stored and returned by `shapeSpace`, but **no read
  path filters on it**. A `private` space is fully discoverable: it appears in `GET /spaces`, is
  returned by `GET /spaces/:id`, and its members/rules are enumerable. That reads as a security bug.

This design closes the gap: `visibility` becomes an enforced discovery gate, mirroring the established
`lib/moderation-visibility.ts` pattern (one authority: a SQL predicate for lists + a single-row 404
gate for direct fetches).

## Non-goals / scope boundary

- **Does not touch content reads.** Whether you can read entities/comments inside a space stays
  `readingPermission`'s job (`lib/space-access.ts`, unchanged). A space can be `visibility=public` +
  `readingPermission=members` (listed, but content is members-only) or `visibility=unlisted` +
  `readingPermission=anyone` (hidden from listings, but content is public once you have the link).
  The two axes are independent and stay independent — **no coupling**.
- **Does not touch `includeChildSpaces` search scoping** — that recursive-CTE subtree scoping in
  `POST /search/content` / `POST /search/ask` remains a content-read concern (`readingPermission`).
- **No DB migration.** The `visibility` column and its enum already exist (migration `0060`), default
  `public`. This is read-path enforcement only.
- **No contract/shape change.** `shapeSpace` already emits `visibility`. The SDK's create/patch
  schemas already accept it.

## Enforcement matrix

| visibility | appears in listings / search | direct fetch by id/slug/short-id | sub-resources (members/team/rules) |
|------------|------------------------------|----------------------------------|------------------------------------|
| `public`   | yes                          | yes                              | yes                                |
| `unlisted` | **no** (hidden)              | **yes** (link-shareable)         | yes                                |
| `private`  | **no** (hidden)              | **404** unless viewer is member/owner/project-admin | **404** unless member/owner/project-admin |

"Viewer is member/owner/project-admin" throughout means: the space owner (`spaces.user_id`), an
**active** member (`space_members.status='active'`), or a project-admin/owner/operator
(`isProjectAdmin(c.var.auth)` — which folds in operator ⊇ owner ⊇ admin per CLAUDE.md). Everyone else,
including unauthenticated callers, is a non-member.

**Two approved decisions baked into the matrix:**

1. **404, not 403, for a hidden `private` space on direct fetch.** A 403 confirms the space exists; the
   whole point of `private` is to hide existence. We return the same `404 spaces/not-found` a
   non-existent id returns, so a probe can't distinguish "private and not yours" from "doesn't exist."
2. **`unlisted` is link-shareable.** It is hidden from listings/search but fully fetchable by anyone who
   has the id/slug/short-id. Only `private` bites on direct fetch.

## New unit: `apps/api/src/lib/space-visibility.ts`

Mirrors `lib/moderation-visibility.ts` (a list predicate + a single-row gate) and reuses the ownership
/active-member/project-admin logic already proven in `lib/space-access.ts`.

### `discoverableSpacesSql(c): SQL | undefined`

The list/search predicate. Correlates to the outer `spaces` row via `spaces.id` / `spaces.userId` /
`spaces.visibility` (Drizzle columns), so it drops directly into an existing `and(...conds)` WHERE.

- **Project-admin** (`isProjectAdmin(c.var.auth)`) → returns `undefined` (unfiltered — sees everything,
  same convention as `readableEntitiesFilter`; `and()` ignores `undefined`).
- **Unauthenticated** → `sql\`${spaces.visibility} = 'public'\`` (public only).
- **Authenticated non-admin** →
  ```
  (spaces.visibility = 'public'
    OR spaces.user_id = :uid::uuid
    OR EXISTS (SELECT 1 FROM space_members m
               WHERE m.space_id = spaces.id AND m.user_id = :uid::uuid AND m.status = 'active'))
  ```
  i.e. **public ∪ yours** (owned or actively-joined), regardless of that space's visibility. This is
  the single uniform predicate on every listing surface (the approved "Uniform: public ∪ yours" model).

Parameterized via the `sql` tag with an explicit `::uuid` cast (never string-interpolated), matching
`readableEntitiesFilter`.

### `assertSpaceVisible(c, space): Promise<void>`

Single-row gate for direct fetches **when the handler already holds the space row** (`getSpace`-based
handlers, `by-slug`, `by-short-id`). `space` must carry `{ id, userId, visibility }`.

- `visibility !== 'private'` → return (public and unlisted are both directly fetchable).
- `isProjectAdmin(c.var.auth)` → return.
- owner (`space.userId === uid`) or active member → return.
- otherwise → `throw Errors.notFound("spaces/not-found", "Space not found")` (**404, not 403**).

### `assertSpaceVisibleById(c, spaceId): Promise<void>`

Same gate for handlers that **don't** load the space row (`/:id/members`, `/:id/team`, `/:id/rules`,
`/:id/rules/:ruleId`, and the parent gate on `/:id/children`). Loads the minimal row
(`{ userId, visibility }`, `deleted_at is null`) and delegates to the same decision.

- Space missing/deleted → `throw Errors.notFound("spaces/not-found", ...)` (fail closed: a
  non-existent space and a hidden private space are indistinguishable, consistent with the row form).

Both functions share one private `visibleToViewer(c, space): Promise<boolean>` helper that encodes the
non-private / project-admin / owner-or-active-member decision, so the two entry points can never drift.
The active-membership lookup mirrors `isOwnerOrActiveMember` in `space-access.ts`.

## Surface wiring

### Listing surfaces — push `discoverableSpacesSql(c)` into the WHERE

| Surface | File | Change |
|---------|------|--------|
| `GET /spaces` (directory) | `routes/spaces.ts` (`.get("/")`, ~L82 `conds`) | `conds.push(discoverableSpacesSql(c))` — count + page queries both use `and(...conds)`, so pagination `totalCount` stays correct. |
| `GET /spaces/:id/children` | `routes/spaces.ts` (`.get("/:id/children")`, ~L288) | (1) `await assertSpaceVisibleById(c, c.req.param("id"))` — gate the **parent** (can't enumerate children of a space you can't see); (2) add `discoverableSpacesSql(c)` to the children `where` so hidden child rows are filtered too. |
| `POST /search/spaces` | `routes/search.ts` (~L192) | add `discoverableSpacesSql(c)` to the existing `and(...)` alongside the ILIKE name/slug/description conditions. |

`memberOf=true` on `GET /spaces` already restricts to the caller's active memberships; the predicate is
still additive and correct there (public ∪ yours ∩ yours = yours).

### Direct-fetch surfaces — call the single-row gate after loading the row

| Surface | File | Change |
|---------|------|--------|
| `GET /spaces/:id` | `routes/spaces.ts` (~L212) | after `getSpace(c)`: `await assertSpaceVisible(c, space)`. |
| `GET /spaces/by-slug` | `routes/spaces.ts` (~L158) | after the row loads (before shaping): `await assertSpaceVisible(c, row)`. |
| `GET /spaces/by-short-id` | `routes/spaces.ts` (~L150) | same. |
| `GET /spaces/:id/breadcrumb` | `routes/spaces.ts` (~L276) | gate the **target** with `assertSpaceVisible(c, current)`, then **truncate** the ancestor chain: while walking up, stop at the first ancestor that fails `visibleToViewer` and drop it + everything above (see below). |

### Sub-resource reads (Thorough) — gate the space first with `assertSpaceVisibleById`

Per the approved **Thorough** decision, every `GET /spaces/:id/*` read applies the single-row gate so a
`private` space can't be probed through a sub-resource:

| Surface | File | Change |
|---------|------|--------|
| `GET /spaces/:id/members` | `routes/spaces.ts` (~L335) | `await assertSpaceVisibleById(c, c.req.param("id"))` at handler top. |
| `GET /spaces/:id/team` | `routes/spaces.ts` (~L351) | same. |
| `GET /spaces/:id/rules` | `routes/spaces.ts` (~L428) | same. |
| `GET /spaces/:id/rules/:ruleId` | `routes/spaces.ts` (~L454) | same. |
| `GET /spaces/:id/membership/me` | `routes/spaces.ts` (~L312) | after `getSpace(c)`: `await assertSpaceVisible(c, space)`. (`requireAuth`; a non-member of a private space gets 404 rather than a "you're not a member" body — hides existence.) |

**Breadcrumb truncation detail.** `GET /spaces/:id/breadcrumb` returns the ancestor chain root→target.
After gating the target, walk up as today, but before `unshift`-ing each ancestor, check
`visibleToViewer(c, ancestor)`; on the first non-visible ancestor, stop the walk (drop it and all
higher ancestors). Result: a viewer sees the visible tail of the path down to the target they're
allowed to see, never a hidden ancestor's name. (A private ancestor of a space you *can* see is rare
but possible after reparenting; fail closed.)

### Handlers that need NO change

- `GET /spaces/user-spaces` (`requireAuth`) — already scoped to the caller's memberships.
- `GET /spaces/mutual/:userId` (`requireAuth`) — already scoped to spaces both users actively belong to
  (⊆ "yours" for the caller).
- `GET /spaces/check-slug` — returns only `{ available: boolean }`, no space data; a slug-existence
  probe is acceptable (slugs are chosen public identifiers, not secrets), and gating it would break
  create-form validation. **Explicitly out of scope; noted so it's a decision, not an omission.**
- All **mutation** handlers (`POST`/`PATCH`/`DELETE /:id...`) — already gated by `requireSpaceRole` /
  ownership, which 403s a non-member before any visibility question arises. No visibility gate added
  (their role check is stricter than visibility).

## Testing plan

Security negatives are first-class: every "hidden"/"404" row is asserted, not just the happy path.

### Unit — `apps/api/src/lib/space-visibility.test.ts` (no DB)

Test the pure decision logic by constructing minimal `c` stubs (`c.var.auth`) and space rows:

- `discoverableSpacesSql`: project-admin → `undefined`; unauth → predicate references only
  `visibility = 'public'`; authed non-admin → predicate includes the `user_id` and active-membership
  branches. (Assert on the compiled SQL fragment shape, as `moderation-visibility` tests do.)
- `visibleToViewer` / `assertSpaceVisible` branch table (with the membership lookup stubbed):
  - `public` → visible for unauth, non-member, member, admin.
  - `unlisted` → visible for all of the above (link-fetchable).
  - `private` → visible ONLY for owner, active member, project-admin; **throws 404** for unauth and
    non-member; a `pending`/`banned` (non-active) membership does **not** grant visibility.
  - `assertSpaceVisibleById` on a missing/deleted space → throws 404.

### Integration — `test/integration/space-visibility.test.ts` (real Postgres, isolated by `project_id`)

Seed within one project: a `public`, an `unlisted`, and a `private` space; an owner, an active member
of the private space, a non-member, and a project-admin. Assert:

- **Listing** (`GET /spaces`): non-member/unauth see only `public`; the private space's owner and
  active member also see it; project-admin sees all three; `unlisted` never appears for a non-member.
- **Search** (`POST /search/spaces`) matching all three by name: same visibility filtering as listing.
- **Direct fetch** (`GET /spaces/:id`, `/by-slug`, `/by-short-id`):
  - `public` → 200 for everyone.
  - `unlisted` → 200 for everyone (link-shareable).
  - `private` → **404** for non-member/unauth; 200 for owner/active-member/project-admin.
- **Children** (`GET /spaces/:id/children`): a `private` child of a `public` parent is absent for a
  non-member; a `private` parent → 404 for a non-member hitting its `/children`.
- **Breadcrumb** (`GET /spaces/:id/breadcrumb`): a `private` ancestor's name is truncated from the chain
  for a non-member (chain starts below it); full chain for a member/admin.
- **Sub-resources** (`GET /spaces/:id/members`, `/team`, `/rules`): **404** on a `private` space for a
  non-member; 200 for member/admin.
- **Membership probe** (`GET /spaces/:id/membership/me`): 404 on a `private` space for a
  non-member (rather than the `isMember:false` body).

## Files

- **Create:** `apps/api/src/lib/space-visibility.ts` (the unit).
- **Create:** `apps/api/src/lib/space-visibility.test.ts` (unit tests).
- **Create:** `test/integration/space-visibility.test.ts` (integration matrix).
- **Modify:** `apps/api/src/routes/spaces.ts` (listing + direct-fetch + sub-resource wiring).
- **Modify:** `apps/api/src/routes/search.ts` (`POST /search/spaces` predicate).
- **Docs:** update `docs/MANIFEST.md` (note the visibility gate on the affected surfaces) and
  `CHANGELOG.md` (`Fixed`: private/unlisted spaces are now hidden from discovery).

## Security posture

- Server is the trust boundary: every gate is server-side; `permissions`/`visibility` in payloads stay
  advisory for clients.
- Fail closed: unknown/deleted space → 404; hidden private → 404 (never a 403 that leaks existence); a
  non-`active` membership never grants visibility.
- All SQL parameterized with explicit `::uuid` casts via the `sql` tag; no user input interpolated.
- No new table, so no new RLS surface. (RLS is defense-in-depth; the server gate is authoritative.)
