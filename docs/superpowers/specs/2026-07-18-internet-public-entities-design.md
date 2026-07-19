# Internet-public entities + anonymous read surface — Design

**Date:** 2026-07-18
**Status:** Approved (brainstormed with Jenova)
**Depends on:** the auth wall (`docs/superpowers/specs/2026-07-17-auth-wall-private-by-default-design.md`, migration `0064`)

## Problem

The auth wall made the API private by default: every `/v7/:projectId/*` route outside the tiny
`AUTH_WALL_ALLOWLIST` requires an authenticated account. That intentionally killed anonymous
reads — but it also killed the legitimate "public comments" use case: a blog/site embedding a
comment thread, or a community showcasing a post to the open internet, with **no visitor account**.

We need a deliberate, narrow, auditable, read-only hole in the wall — not a general loosening.

## Model: the visibility ladder

Visibility is a ladder with three rungs, each a strict superset of the audience below it:

| Rung | Who can read | Enforced by |
|---|---|---|
| **Private** | active members of the space | `space.reading_permission = 'members'` (existing) |
| **Community-public** | any signed-in account on the project | `space.reading_permission = 'anyone'`, behind the auth wall (existing) |
| **Internet-public** | anyone on the internet, no account | **new** `entities.public` flag + the **new `/public/*` surface** |

**Ladder invariant:** internet ⊇ community ⊇ private. A post may only be internet-public if it is
already community-public (spaceless, or in a space whose `reading_permission = 'anyone'`).

**Why the ladder and not an override.** We considered letting `public = true` punch through a
members-only space ("unlisted but linkable" — a private group advertising a post). Rejected on
privacy grounds: the post's comment thread was written by members under an expectation of privacy,
and publishing the post would retroactively world-expose their words. The ladder structurally
eliminates that class of problem — a publishable post's thread was **never** private, so there is
no retroactive-exposure question, no per-comment consent question, nothing to warn about.

## 1. Data model

One new column on `entities` (Drizzle schema: `packages/core/src/db/schema/content.ts`):

```
is_public boolean NOT NULL DEFAULT false     -- Drizzle property isPublic; API field `public`
```

(Named `is_public` mirroring `is_draft`; the shaped API field is `public`.)

- Migration `0065` (hand-authored SQL — `db:generate` is unreliable; confirm the number is still
  free at implementation time: two parked plans also eye `0065`).
- No new table → no new RLS work. The `0017` deny-all backstop plus `0064`'s anon `SELECT` revoke
  already cover the column; the server remains the trust boundary and the `/public/*` routes are
  served by the RLS-bypassing owner role like everything else.
- Partial index `(project_id) WHERE public` is unnecessary at v1 scale — reads are by primary key.

## 2. Write side — publishing an entity

### Endpoint

```
PATCH /v7/:projectId/entities/:id/visibility        body: { public: boolean }
```

A **dedicated action**, not a field on the owner-gated `PATCH /entities/:id` — its authority model
is different (privileged, not owner). (`/:id/publish` is already taken by draft-publishing; the
action is named `/visibility`, NOT `/public`, to avoid any confusion with the anonymous
`/public/*` read namespace — this route lives in the auth-walled entities router.)
Returns the shaped entity.

### Authority (who may flip the flag, either direction)

- platform **operator** (`isProjectAdmin` folds it in), OR
- **project owner/admin** (`isProjectAdmin(c.var.auth)`), OR
- the entity's **space owner or space admin** (`space.user_id` owner ⇒ admin, or an active
  `space_members` row with role `admin`; `moderator` does NOT qualify).

**Never** the ordinary author. Authors asking stewards/admins to publish is a parked v2 (below).
For a spaceless entity there is no space admin, so the gate reduces to operator/project-admin.

**Error posture (no existence leak):** nonexistent entity → `404`. Entity the caller cannot READ
(members-only space, caller not a member) → **`404`**, never 403 — the endpoint must not become an
existence oracle for private-space content (per the space-visibility 404-never-403 posture).
Entity the caller can read but isn't authorized to publish → `403 entities/not-authorized`
(existence is already known on this rung).

### Ladder validation

Setting `public: true` is **rejected `400 entities/not-community-public`** unless, live:
`entity.space_id IS NULL` OR its space exists, is not deleted, and has
`reading_permission = 'anyone'`. Setting `public: false` is always allowed (for the authorized
set), including when the space has since gone members-only — un-publishing must never be blocked.

Validation body via zod in `packages/contract` (`{ public: z.boolean() }`), parsed with
`parseBody`.

### Contract change (additive)

The shaped `Entity` (`packages/contract` `Entity` type + `apps/api/src/lib/shape.ts`
`shapeEntity`) gains `public: boolean`. Additive only — SDK-safe. `MODELS.md` updated.

## 3. Read side — the anonymous `/public/*` surface

New router `apps/api/src/routes/public.ts`, mounted under `/v7/:projectId/public/*`. All routes
are **GET-only, anonymous, read-only**:

| Route | Mirrors | Returns |
|---|---|---|
| `GET /public/entities/:id` | `GET /entities/:id` | the shaped entity |
| `GET /public/entities/:id/comments` | `GET /comments?entityId=` | paginated top-level list, `{ data, pagination }` |
| `GET /public/entities/:id/comments/thread` | `GET /comments/thread` | nested subtree via `fetch_comment_thread` |

No single-comment permalink in v1 (YAGNI).

### The gate — every route, independently

A shared helper (new `lib/public-access.ts`), called at the top of **each** route — no route
trusts that another ran first:

```
assertEntityInternetPublic(projectId, entityId) passes IFF, live:
  entity exists in this project
  AND entity.public = true
  AND entity.deleted_at IS NULL
  AND entity.is_draft = false
  AND entity.moderation_status IS DISTINCT FROM 'removed'
  AND ( entity.space_id IS NULL
        OR (space exists AND space.deleted_at IS NULL
            AND space.reading_permission = 'anyone') )
→ otherwise 404 common/not-found
```

- **404, never 403** — the anonymous surface must never reveal that a non-public entity exists
  (matching the space-visibility 404-not-403 posture).
- **Live, no cache, fail-closed.** Flipping the space to members-only, soft-deleting the entity,
  or a moderation removal instantly un-exposes the post even while `public` is still `true`. The
  stale `public` flag is harmless because the gate re-derives the conjunction on every request.
- The comment routes additionally scope their queries by `entity_id` exactly as the existing
  comment routes do; comment-side moderation visibility is `hideRemoved = true` unconditionally
  (an anonymous caller is by definition not privileged) — removed comments omitted / pruned by
  `fetch_comment_thread(..., p_hide_removed => true)`, deleted comments blanked by the shaper.
- Shaping: reuse `shapeEntity` / `shapeComment` + `loadUsers` unchanged. With no viewer,
  `userReaction` is `null` and `isSaved` is `false`/absent, which the shapers already produce for
  an anonymous context. No new shape code.

### Auth wall — the one deliberate hole

Add prefix `"/public/"` to `AUTH_WALL_ALLOWLIST.prefixes`
(`packages/core/src/middleware/auth.ts`). Per that file's own contract, this ships **with this
spec as the rationale** and **updates the pinning test** (`auth-wall.test.ts`). Allowlisted paths
get optionalAuth semantics, which is fine: a signed-in user hitting `/public/*` gets the same
gate (the routes never branch on `c.var.auth`; privileged users use the normal surface).

The existing authed `/comments`, `/comments/thread`, `/entities/:id` are **untouched** — still
behind the wall, still space-gated by `assertCanReadEntity`. This surface is purely additive.

### CORS

`/public/*` responses set `Access-Control-Allow-Origin: *` (no credentials) via a route-local
`cors()` — safe because the surface is anonymous, read-only, and serves only internet-public
data; required because the whole point is third-party origins embedding the thread. The rest of
the API keeps the configured `CORS_ORIGIN`.

### Rate limiting / abuse

The existing `/v7/*` IP-keyed rate limiter already covers the surface (it mounts above the
routers). No extra limiter in v1; if scraping becomes a problem, a stricter per-route cap can be
added the way `/auth/*` has one.

## 4. Testing (security-first — negatives are the point)

**Integration** (`test/integration/public-read.test.ts`, real Postgres, project-scoped):

- anon (no token) reads a public spaceless entity + its comments + thread → 200, correct shapes,
  `userReaction: null`.
- anon reads a public entity in a public space → 200.
- anon on `public = false` entity → **404** on all three routes.
- anon on a `public = true` entity whose space was flipped to `members` → **404** (the live
  backstop) — each of the three routes asserted independently.
- anon on a draft / soft-deleted / moderation-removed public entity → **404**.
- removed comment in a public thread → omitted from list AND thread; deleted comment → blanked.
- write side: ordinary member 403; the author 403; space admin 200; space **moderator** 403;
  project admin 200; operator 200.
- write side existence posture: authed non-member PATCHing a members-only-space entity → **404**
  (not 403); nonexistent entity id → 404.
- ladder: `public: true` on a members-only-space entity → **400**; `public: false` on the same →
  200.
- non-public surface unchanged: anon on the walled `GET /entities/:id` still 401.

**Unit:** the allowlist pin in `auth-wall.test.ts` gains `"/public/"`; if the ladder predicate is
extracted pure, it gets a matrix test.

## 5. Parked (v2, documented not built)

- **Author "request to publish":** an author asks; stewards/project-admins/space-admins approve,
  approval flips `public`. Reuses the steward caseload pattern.
- Single-comment public permalink.
- Public space-level or project-level "all public posts" listing (discovery). v1 is deliberately
  by-direct-link only: you must know the entity id.

## 6. Docs / propagation

- `MANIFEST.md`: new **§public** (Agora extension, not Replyke-derived) + the new
  `PATCH /entities/:id/visibility` action; `MODELS.md`: Entity `public` field.
- `CHANGELOG.md` under `[Unreleased]`.
- Run `/propagate` before finishing the branch (env untouched, but docs/wiki mirrors).
