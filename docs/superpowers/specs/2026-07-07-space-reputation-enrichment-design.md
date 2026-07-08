# Space-reputation enrichment — wiring design

**Date:** 2026-07-07
**Feature:** v7.8.2 SDK-sync #6 — space-scoped reputation enrichment (`spaceReputationId` / `spaceReputationDescendants`)
**Status:** design approved (brainstorm) → writing-plans next

---

## Goal

Connect the already-built space-reputation **store** and **engine** to the API's response
shapers so embedded/returned users actually carry a `spaceReputation` value when the SDK asks
for it — closing the gap left after the v7.8.2 merge (validator wired, but emits nothing).

## What already exists (do NOT rebuild)

- **Store:** `space_reputation (project_id, space_id, user_id, reputation)`, composite PK,
  trigger-maintained (migrations `0058`/`0059`). No new migration needed.
- **Engine:** `loadSpaceReputations(projectId, spaceId, includeDescendants, userIds) → Map<userId,number>`
  (`apps/api/src/lib/space-reputation.ts`) — every requested id present (absent → 0), with a
  recursive-CTE descendant rollup when `includeDescendants`. Unit-tested.
- **Pure helper:** `fillReputationMap(rows, userIds)` — unit-tested.
- **Validator:** `validateSpaceReputationParams(raw, endpointClass)` — unit-tested. Throws the
  contract 400s (bad id; `"context"` on a user-direct route). Currently only invoked inline in
  `routes/users.ts` (`checkSpaceRep`) and emits nothing.

## Scope (phased)

**In this phase:** the `uuid` and `"none"` modes, across every endpoint the SDK threads the param
onto, including descendant rollup (the engine already supports it).

**Deferred (labeled follow-up):** the `"context"` mode (each embedded user scored in *that row's own*
space). It requires per-row `(userId, spaceId)` grouping and a definition for rows lacking a
`spaceId`; that machinery is out of scope here.

## Contract value modes

| `spaceReputationId` | meaning | this phase |
|---|---|---|
| `<uuid>` | reputation in that one space (with `spaceReputationDescendants` → subtree rollup) | ✅ implemented |
| `"none"` | global reputation (alias the existing `profiles.reputation`) | ✅ implemented |
| `"context"` | per-row's own space | ⏸ validates OK, **emits nothing** (see Behavior) |
| absent | no enrichment (today's behavior) | ✅ unchanged |

`spaceReputationDescendants` is only honored with an explicit `<uuid>` (the validator already
enforces this).

## Architecture — approach A: centralized post-shape enrichment

Three moving parts, plus the contract field. Shapers and `loadUsers` are left **unchanged** —
enrichment is a post-shape pass, so absent-param responses stay byte-identical to today.

### 1. Contract field

Add `spaceReputation?: number` to the `User` interface (`packages/contract/src/types.ts`).
`AuthUser`/`UserFull` `extends User`, so this covers every embedded and self shape. Optional →
absent when not requested (SDK-tolerant). Rebuild the contract (`pnpm --filter @agora-server/contract build`).

`shapeUser` is **not** changed: it never sets the field; the enrichment pass stamps it.

### 2. Directive + validation middleware

`spaceRepGate(endpointClass: "context" | "user-direct")` — a per-router middleware:

- reads `spaceReputationId` / `spaceReputationDescendants` from the query,
- calls `validateSpaceReputationParams` (throws the 400s — so validation can never be forgotten on
  a mounted route),
- resolves and stashes a directive on the request context (`c.set("spaceRep", …)`):
  - no param, **or** `"context"` this phase → `null`
  - `"none"` → `{ mode: "global" }`
  - `<uuid>` → `{ mode: "space", spaceId, includeDescendants }`

Replaces the ad-hoc `checkSpaceRep` inline in `routes/users.ts`.

### 3. Enrichment pass — `apps/api/src/lib/space-reputation-enrich.ts`

`enrichSpaceReputation(c, payload) → Promise<payload>`:

1. read the directive; if `null` → return `payload` untouched (no walk, no DB).
2. recursively collect every embedded **full `User`** in `payload` into a de-duped set, matched by
   **exact signature**: an object where `"role" in o && "username" in o && "reputation" in o && "createdAt" in o`.
   This catches arbitrarily-nested users (`entity.topComment.user`, `connection.connectedUser`,
   `otherMembers[]`) and — by requiring the full User signature — ignores `Entity`/`Comment`/`Space`
   objects (none carry `role`+`username`+`reputation`) **and the reduced moderation `userSummary`
   shape** (`{id, username, name, reputation}` — no `role`/`createdAt`). This is intentional: a
   summary is not an SDK `User`, so `spaceReputation` does not belong on it. (The plan verifies the
   covered `reports` endpoints against their real response shapes — where they embed a full `User`,
   it is enriched; where they embed only a summary, it is deliberately not.)
3. `mode:"global"` → for each user, `u.spaceReputation = u.reputation`.
4. `mode:"space"` → `map = await loadSpaceReputations(projectId, spaceId, includeDescendants, [...ids])`;
   for each user, `u.spaceReputation = map.get(u.id) ?? 0`.
5. return `payload`.

**Invariants:** additive-only (writes nothing but `spaceReputation`); runs only when the caller
opted in (directive non-null); zero users → no DB call.

Covered handlers wrap their return: `return c.json(await enrichSpaceReputation(c, payload))`.

## Coverage

**Principle:** cover exactly the endpoints the SDK threads the param onto — no more, no less. The
SDK's `buildSpaceReputationParams` (`utils/spaceReputationParams.ts`) flattens the object form onto
these families only.

**Context class** (`spaceRepGate("context")` — accepts `uuid | none | context`):
`entities`, `comments`, reaction listings that embed `user`, `chat` (members/conversations),
`spaces` (team/members), `search` (`/users`, and content results embedding authors), `reports`,
`follows`, `connections`.

**User-direct class** (`spaceRepGate("user-direct")` — accepts `uuid | none`; `"context"` → 400):
`users`.

**Out of scope** (SDK never sends the param there → mounting would be dead code):
`events`, `steward`, `admin`, `roles`. (Space-rep on the admin/steward operator views is a possible
future *product* feature, not part of the SDK sync.)

Under-covering degrades gracefully (optional field simply absent); over-covering is harmless waste.
Matching the SDK list exactly is the honest, minimal choice.

## Behavior & edge cases

- **`"context"` this phase:** validates OK on context routes (value is contractually valid — we do
  **not** 400 it), resolves to a `null` directive → **emits nothing**, with a one-line `debug` log
  noting the deferral. Forward-compatible: the same request starts returning values when context
  lands, no client change. Validation stays permissive; deferral lives in the enrichment layer, not
  the validation contract.
- **`"none"`:** aliases global `reputation` (per spec — exercises the plumbing before space math).
- **`spaceReputationDescendants=true` with a uuid:** subtree rollup via the engine's recursive CTE.
- **Empty payload / zero embedded users:** no walk cost beyond a shallow scan; no DB call.
- **Absent param:** response is byte-identical to today (no field).

## Testing

**Unit** (`src/**/*.test.ts`, no DB):
- the recursive user-collector: nesting depth, dedupe by id, signature precision (must collect
  `User`s and **ignore** `Entity`/`Comment`/`Space` objects that share some keys).
- the directive resolver: `absent`/`none`/`uuid`/`context` → correct directive; `"context"` on
  `user-direct` throws; `descendants` only with a uuid.
- `mode:"global"` mapping (spaceReputation === reputation).
- (`loadSpaceReputations` / `fillReputationMap` / `validateSpaceReputationParams` already covered.)

**Integration** (`test/integration/**`, real Postgres, isolated by `project_id`):
- seed `space_reputation` rows; assert `GET /users/:id?spaceReputationId=<uuid>` carries the right
  number, and an **embedded** case (e.g. an entity's author) does too.
- `"none"` → `spaceReputation` mirrors global `reputation`.
- `spaceReputationDescendants=true` → subtree rollup sums descendant-space reputation.
- `"context"` → **400** on a `users` route; **no field emitted** on a context route.
- absent param → no field (regression guard).

## Non-goals / out of scope

- The `"context"` mode (deferred, labeled follow-up).
- Any new reputation *math* or store change — the trigger-maintained `space_reputation` table and
  the engine are the source of truth; this feature only reads them.
- `events`/`steward`/`admin`/`roles` coverage.

## Compat

Fully non-breaking both directions: absent param → no enrichment (unchanged); a client on an old
server → param ignored; `spaceReputation` is optional on the SDK `User` type, so its absence is
always tolerated.

## Docs to update

- `CHANGELOG.md` (`[Unreleased]` → Added): space-reputation enrichment (`uuid`/`none`), coverage,
  `context` deferred.
- `docs/MANIFEST.md`: the param on the covered endpoint families; drop the "no param" note in §6.
- `docs/MODELS.md`: `User.spaceReputation`; drop the "scaffold / emits nothing" language.
