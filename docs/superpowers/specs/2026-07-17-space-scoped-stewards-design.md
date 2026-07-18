# Space-Scoped Stewards — Design (Foundation Phase)

**Date:** 2026-07-17
**Status:** Approved design, pre-implementation
**Phase:** 1 of 3 (foundation). Elections and broader space-scoped admin surfaces are later phases
that build on the seams defined here (§9).

## 1. Purpose

Let each space run its own conflict-resolution bench. A steward grant can now be **scoped to a
space**: the grantee sees and works only that space's caseload in the admin app's Steward tab, is
notified when a case is opened in their space, and is appointed by the space's own admins — real
community self-governance per space, without touching the project-wide steward tier.

Vocabulary: a **project steward** holds today's project-wide grant (`space_id IS NULL`); a **space
steward** holds a grant scoped to one space. One person may hold several grants.

## 2. Decisions made (with rationale)

| Decision | Choice |
|---|---|
| Scope of this phase | Foundation only: scoped grants, scoped case visibility, scoped notifications, admin Steward tab honoring scope. Elections + general space-scoped admin access are separate follow-on specs. |
| Grant home | `project_roles` gains a nullable `space_id`. `NULL` = project-wide (existing rows unchanged). Keeps the conflict axis out of `space_members` (the content-moderation axis) and gives elections one table to write. |
| Appointment power | Space admins (`requireSpaceRole(admin)`, owner⇒admin folds) for their own space, OR project owner (`requireProjectOwner`). Self-governance from day one; elections later are just another writer through this seam. |
| Escalation | Full parity within scope. A space steward can escalate (content removal via the normal moderation path) for cases in their space — space admins/moderators already wield removal there, so this grants nothing the space's governance tier doesn't already have. |
| Membership coupling | Grant requires the grantee be an **active member** of the space; leaving or being removed from the space **auto-revokes** the steward grant in the same transaction. Invariant: every space steward is a member. Elections will assume it. |
| Claims strategy (Approach A) | One new boolean JWT claim `spaceSteward` ("holds ≥1 space grant") for admin-SPA tab gating only. All real authorization is request-time via a cached resolver — in-grain with `requireSpaceRole`, and revocation bites in ≤30s instead of at token refresh. |

Rejected alternatives: `stewardSpaceIds[]` in the JWT (unbounded claim, refresh-lagged revocation);
a new `space_members` role (merges axes); a new `space_stewards` table (walks back the
`project_stewards`→`project_roles` consolidation); SPA probing endpoints for nav gating (no
precedent in the admin app).

## 3. Data model

One migration (hand-written portions per repo convention; journal `when` must exceed current max —
see the drizzle-journal-timestamp gotcha):

- `project_roles.space_id uuid NULL REFERENCES spaces(id) ON DELETE CASCADE` — deleting a space
  deletes its steward grants.
- `CHECK (space_id IS NULL OR role = 'steward')` — only stewardship is space-scopable; owner/admin
  stay project-wide. Fails closed against a future writer scoping the wrong role.
- Replace `project_roles_unique (project_id, profile_id, role)` with a partial-unique pair
  (Postgres NULLs are distinct, so one constraint can't cover both):
  - `UNIQUE (project_id, profile_id, role) WHERE space_id IS NULL` (preserves today's semantics)
  - `UNIQUE (project_id, profile_id, role, space_id) WHERE space_id IS NOT NULL`
  - `grantProjectRole`'s `onConflictDoNothing()` (no target) continues to work against either.
- New index `project_roles_space_idx (project_id, space_id) WHERE space_id IS NOT NULL` for
  "who stewards this space" lookups (grant listing + notification fan-out).
- RLS: table already carries deny-all (0045); the new column changes nothing.

**No change to `steward_cases`** — `space_id` already exists. Note its FK is `ON DELETE SET NULL`:
deleting a space promotes its cases to project-level (visible to project stewards/admins only).
That is intended — cases outlive the space; the space's bench dissolves with the space.

## 4. Resolution & claims

`packages/core` + `apps/api` (edit kernel modules in core; api shims re-export):

- `lib/project-roles.ts`:
  - `getProjectRoles()` filters `space_id IS NULL` — **unchanged meaning** for every existing
    consumer (JWT mint, guards, `isSteward`).
  - New `getStewardSpaceIds(projectId, profileId): Promise<Set<string>>` — space ids where the
    profile holds a scoped steward grant. Same 30s cache + `invalidateProjectRoles` keying.
  - `grantProjectRole`/`revokeProjectRole`/`listRoleGrantees` gain an optional `spaceId` parameter
    (default undefined = project-wide, existing call sites untouched). `grantProjectRole` throws
    when `spaceId` is set with a role other than `steward` — the app-level twin of the DB CHECK
    (defense-in-depth; the CHECK is the backstop). The last-owner guard is unaffected (owners are
    always project-wide).
- `lib/tokens.ts`: mint/refresh stamps `spaceSteward: boolean` from `getStewardSpaceIds(...).size > 0`.
- `middleware/auth.ts` (core): reads the claim back as `c.var.auth.isSpaceSteward`.
- `packages/contract` `AuthContext`: `+ isSpaceSteward: boolean` (UI-gating claim; authorization is
  request-time — document that in the JSDoc). Contract builds first (`pnpm -r build`).

## 5. Steward route gating

`routes/steward.ts`'s `requireSteward(c)` is replaced by a scope resolver:

```ts
type StewardScope = { all: true } | { all: false; spaceIds: Set<string> };

async function resolveStewardScope(c): Promise<StewardScope>
// isProjectAdmin(auth) || auth.isSteward           → { all: true }
// getStewardSpaceIds(projectId, userId) non-empty   → { all: false, spaceIds }
// otherwise                                         → throw 403 steward/forbidden
```

Application per endpoint (every steward route resolves scope first):

- `GET /cases` (+ any list): `{all:false}` appends `spaceId IN (scope)`. Project-level cases
  (`space_id NULL`) are **invisible** to space stewards.
- `GET/PATCH /cases/:id`, notes, channels, escalate: load the case, then out-of-scope → **404
  `steward/case-not-found`** (never 403 — do not leak case existence; mirrors the space-visibility
  404-never-403 rule).
- `POST /cases`: a space steward must supply (or inherit from the report) a `spaceId` in scope;
  else 404 on the report path (report effectively not visible to them) / 403
  `steward/space-required` when opening cold without a scoped space.
- `POST /cases/:id/escalate`: additionally verify the subject content row's own `space_id` equals
  the case's `spaceId`; mismatch → 409 `steward/subject-space-mismatch`. Fail closed: a scoped
  steward can never remove content outside their space via a mislabeled case.
- Mediation/caucus channel ops inherit scope for free (all pass through the case load).
- Assignment (`assignedToId`): assignable to any steward whose scope covers the case.

## 6. Grant management

New space-scoped surface in `routes/steward.ts` (project-wide endpoints untouched):

- `GET /steward/spaces/:spaceId/stewards` — list the space's bench. Gate: space admin or project
  owner (space read-visibility rules apply first; unknown/invisible space → 404).
- `POST /steward/spaces/:spaceId/stewards { userId }` — gate: `requireSpaceRole(admin)` OR
  `requireProjectOwner`. Validates active membership → else `400 steward/not-a-member`. Writes
  `project_roles (role='steward', space_id)`; idempotent.
- `DELETE /steward/spaces/:spaceId/stewards/:userId` — same gate.
- **Auto-revoke wiring** (`routes/spaces.ts`): every path that ends an active membership — leave
  (`DELETE /:id/leave`), member removal (`DELETE /:id/members/:memberId`), and any ban/decline
  transition that deactivates an active member (enumerate at implementation time) — deletes any
  `(role='steward', space_id)` row for that user in the same transaction as the membership change,
  then invalidates the roles cache. Log at `info` (message only, per Log-with-intent).
- New `GET /steward/scope` — returns `{ all: true }` or `{ all: false, spaces: [{id, name}] }` so
  the SPA can label a scoped view honestly. Gated by the same scope resolver (403 for non-stewards).

All grant mutations log `info` (message only); token-refresh effect: the `spaceSteward` claim
appears at next refresh, but since authorization is request-time, a fresh grant works immediately
via API even before the tab appears.

## 7. Scoped notifications

- `stewardCaseRecipients` (`lib/notifications.ts`, pure + unit-tested) gains a new rule: on
  `kind: "opened"` the return set includes a directive to notify the case's space bench. To keep
  the function pure, it returns a marker (`{ role: "space-stewards" }`) which
  `notifyStewardCaseEvent` expands via `listRoleGrantees(projectId, "steward", spaceId)`, minus the
  actor, minus the parties.
- New notification type `steward-case-opened`; metadata `{ caseId, spaceId }`, deep-linking to the
  admin Steward tab. **PII rule:** payload carries no complainant/respondent identity — "a case was
  opened in <space>" only.
- Cases with no `spaceId` notify no stewards (unchanged behavior) — the feature is purely additive.
- The existing party-notification `notifyPolicy` matrix is untouched.
- Push: `steward-case-opened` is **not** added to the push-worthy allowlist in this phase (in-app
  only); revisit with real usage.

## 8. Admin SPA

- Steward tab visibility: `isSteward || isProjectAdmin(...) || isSpaceSteward`.
- Caseload/case views render server-filtered data unchanged — no client-side scope logic. A
  "Scoped to: <space names>" banner appears when `GET /steward/scope` returns `{all: false}`.
- Bench management UI lives on the space detail page (space admins manage their own bench there),
  not in the project-level Steward settings panel.

## 9. Later phases (seams, not scope)

- **Elections:** an election module writes/removes `project_roles (role='steward', space_id)` rows
  through `grantProjectRole`/`revokeProjectRole` — no new authz seam needed.
- **Opt-in toggle:** a `spaces` flag gating the grant endpoints (§6) — "does this space want
  self-governance."
- **Broader space-scoped admin surfaces** (dashboard/moderation for your space): reuse the
  `StewardScope` shape as the general pattern.

## 10. Testing

Security-relevant logic is the highest priority; negative cases carry the weight.

**Unit (`src/**/*.test.ts`, no DB):**
- Scope resolver matrix: project admin / project steward / space steward / both / none.
- `stewardCaseRecipients`: the new opened→space-bench rule beside the existing `notifyPolicy`
  matrix (extend `steward-notify.test.ts`); actor and parties excluded.
- Grant validation branches: not-a-member rejection; `grantProjectRole` throws on a space-scoped
  non-steward role (the app-level guard — the DB CHECK itself is asserted in the integration suite).

**Integration (`test/integration/steward-space-scope.test.ts`, real Postgres, project-isolated):**
- Space steward sees only their space's cases; project-level cases invisible; out-of-scope single
  reads/patches/escalations 404.
- Escalate: in-scope succeeds and removes subject content; subject/case space mismatch 409s and
  removes nothing.
- Grants: space admin can grant; plain member and unrelated space's admin cannot (403); non-member
  grantee 400s; project owner can grant anywhere.
- Auto-revoke: leaving the space (and being removed) strips case access on the next request
  (cache invalidated).
- Notifications: opening a case in space A notifies A's steward, not B's steward, not the actor.
- Project-wide steward flow: entirely unaffected (regression guard over the existing suite).

**Gates before done:** `pnpm -r typecheck` + `pnpm test` + the new integration file green;
CHANGELOG entry; `pnpm check:propagation --diff` for doc mirrors (MANIFEST/MODELS gain the new
endpoints + notification type + `AuthContext` field).

## 11. Out of scope (explicit)

- Elections/voting mechanics, terms, quorums.
- The per-space self-governance opt-in flag (phase 2 — until then, appointment power alone gates).
- Space-scoped views of the Moderation/Dashboard/Settings admin tabs.
- Push delivery of steward notifications.
- Scoping `owner`/`admin` roles to spaces (CHECK constraint forbids it).
