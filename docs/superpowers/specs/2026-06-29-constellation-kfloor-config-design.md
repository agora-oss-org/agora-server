# Adaptive + overridable Constellation k-anonymity floor

**Date:** 2026-06-29
**Status:** Approved (design) — pending implementation
**Scope:** `@agora-server/contract`, `@agora/api` (materializer + admin route), `@agora/admin` (UI)

## Problem

The Constellation (`GET /social/constellation`, `docs/AGORA-SOCIAL.md` §12) renders a community's
anonymous *shape* as cluster blobs. Each blob is suppressed unless its cluster has at least
`constellationKFloor` members (k-anonymity). That floor is currently a **fixed 5**, hard-clamped in
the shared contract (`z.number().int().min(5)` on write, `Math.max(5, …)` on read) and documented as
"not tier-relaxable."

For a small community — say a dozen members — Louvain (or the by-space fallback) produces clusters of
2–4 people, **all** of which fall below 5 and are suppressed. The community sees an empty / "still
forming" constellation forever, even though it has real structure. A community that small should be
able to see an accurate constellation of itself.

## Goals

- Small communities get an accurate, non-empty constellation out of the box.
- Large communities keep the privacy-meaningful floor of 5, unchanged.
- A community can deliberately tune its own privacy posture (looser *or* tighter).
- Never ship a blob that represents a single identifiable person — "anonymous shape" stays literally
  true.

## Non-goals

- Per-space floors (the constellation is project-wide; `N` is total project members).
- Exposing the floor value to members (it is not in `transparencyView` and stays that way).
- Auto-recomputing the snapshot on every settings write (a heavy GDS job stays out of a settings
  request).

## Decisions (settled in brainstorming)

1. **Hybrid control model** — adaptive default, with an optional manual per-project override.
2. **Hard floor = 2**, inviolable in *both* the adaptive curve and the manual override. A blob always
   represents ≥2 people, so it can never *be* one identifiable individual.
3. **Adaptive tier table**, keyed on total project member count `N`:

   | `N` (project members) | Adaptive floor |
   |---|---|
   | `< 50` | 2 |
   | `50–99` | 3 |
   | `100–499` | 4 |
   | `≥ 500` | 5 |

   (Boundaries are a tunable starting point.)
4. **Data model**: `constellationKFloor: number | null`. `null`/unset = **adaptive** (use the tier
   table at materialization time); an integer `2–1000` = **fixed override**.
5. **Freshness**: persist config immediately; a new **admin force-recompute endpoint** applies a
   change on demand; the existing weekly cron handles steady state. Configuration stays on the
   existing project-admin-gated `PATCH /settings/social`.

## Design

### 1. Contract — `packages/contract/src/social.ts`

The privacy-critical layer. Pure, fully unit-tested.

- **Type:** `ResolvedSocialConfig.constellationKFloor: number | null` (was `number`).
- **Default:** `COMMUNITY_DEFAULTS.constellationKFloor = null` (was `5`). `corporate` inherits it via
  the existing `...COMMUNITY_DEFAULTS` spread — no separate change.
- **New exported pure helper:**

  ```ts
  /** The adaptive (default) k-floor for a project of `memberCount` people. Always ≥2 (the hard
   *  anonymity floor) and ≤5 (the large-community default). Used when constellationKFloor is null. */
  export function adaptiveConstellationFloor(memberCount: number): number {
    if (memberCount < 50) return 2;
    if (memberCount < 100) return 3;
    if (memberCount < 500) return 4;
    return 5;
  }
  ```

- **Schema (write bound):** `constellationKFloor: z.number().int().min(2).max(1000).nullish()` (was
  `min(5)`). Update the `LOCKSTEP` comment to read `min 2`.
- **Resolver (read bound), exact semantics:**
  - `null` / absent / non-numeric / out-of-`[1,1000]` / non-integer / `NaN` → `null` (adaptive). This
    is bounded-safe: adaptive returns `[2,5]`, so a malformed value never produces a floor below 2.
  - integer in `[1,1000]` → `Math.max(2, value)` (so a stored `1` is *raised* to 2, preserving the
    old "below-floor is clamped up, never honored" behavior; `2→2`, `30→30`, `1000→1000`).

  Equivalent to a small local helper:

  ```ts
  function resolveKFloor(v: unknown): number | null {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1000) return null;
    return Math.max(2, v);
  }
  ```

The hard floor of 2 therefore lives in exactly two places: `resolveKFloor`'s `Math.max(2, …)` and
`adaptiveConstellationFloor`'s construction.

### 2. Materializer — `apps/api/src/lib/social-constellation.ts`

In `materializeProject`, after `userIds` is computed, resolve the effective floor:

```ts
const kFloor = cfg.constellationKFloor ?? adaptiveConstellationFloor(userIds.length);
const { blobs, memberCount } = blobsFromCommunities(communities, sP, kFloor);
```

`userIds.length` is already the project member count `N`. No other change — `blobsFromCommunities`
already suppresses clusters `< kFloor`.

### 3. Force-recompute endpoint — `apps/api/src/routes/admin.ts`

New `POST /v7/:projectId/admin/social/constellation/recompute`, a sibling of the existing
`/admin/social/recompute` (analytics). Differences from the analytics one: it is **project-admin
gated** (not operator-only), because the constellation is a member-facing Garden surface configured
via the project-admin `PATCH /settings/social` — whoever can set the floor can recompute it.

- Gate order (mirrors `routes/social.ts`): `requireAuth` → `requireProjectAdmin(c)` → config gate
  (`cfg.graphEnabled && cfg.constellationEnabled`, else `400 social/constellation-disabled`) → infra
  gate (`neo4jEnabled()`, else `503 social/graph-unavailable`).
- Body: none.
- Action: `await rollupConstellation(projectId, { force: true })`.
- Response: `{ recomputed: result.materialized > 0, constellation: await getConstellation(projectId) }`
  so the admin UI gets the fresh snapshot back immediately (parallels analytics returning fresh
  reports).

### 4. Admin UI — `apps/admin` Settings → Social (Phase 2)

- Replace the bare number input (min 5) with an **"Adaptive (recommended)"** default plus an optional
  explicit floor (min 2). When adaptive, show the tier table / the effective floor for this
  community's current size. Saving `null` resets to adaptive.
- Add a **"Recompute constellation now"** button calling the new endpoint, with a "this may take a
  while" affordance (GDS runs synchronously, like the analytics recompute).

### 5. Downstream (noted; not in Phase 1 critical path)

- `number → number | null` is a contract-type widening → **minor version bump** of
  `@agora-server/contract`, plus a root `CHANGELOG.md` entry.
- `agora-sdk-plus` re-exports `ResolvedSocialConfig` (type-only) but never reads
  `constellationKFloor`; on its next contract bump, set `ALL_DISABLED_SOCIAL_CONFIG.constellationKFloor`
  and `transparencyToConfig`'s default to `null`. Not required for the server to function.

## Data / migration

No migration. Existing `projects.social_config` rows that already store a numeric
`constellationKFloor` keep it (clamped `≥2`, honored as a fixed override). Rows without the key
(including the seed/demo project) resolve to `null` → adaptive → small communities now render. The
30s `getSocialConfig` cache plus `invalidateSocialConfig` on PATCH already handle propagation.

## Testing (per repo rules — pure/branching logic ships with unit tests)

**Unit — contract (`packages/contract/src/social.test.ts`):**
- `adaptiveConstellationFloor` boundaries: `0→2, 49→2, 50→3, 99→3, 100→4, 499→4, 500→5, 10000→5`.
- Resolver: `null`/absent → `null`; `1→2`; `2→2`; `30→30`; `1000→1000`; `2000→null`; `0→null`;
  `12.5→null`; `NaN→null`; `"x"→null`.
- Schema: `2` valid, `1` invalid, `1001` invalid, `null` valid, omitted valid.
- **Update** the existing tests that assert the old `5` floor / "raised to 5" / "rejects below 5 —
  not tier-relaxable" to the new `2` semantics, and the `community defaults` test
  (`constellationKFloor` is now `null`). Keep the structural-drift guards green (the key set is
  unchanged).

**Unit — api (`apps/api/src/lib/social-constellation.test.ts`):**
- Existing `blobsFromCommunities` suppression cases remain; add one asserting `kFloor = 2` keeps a
  2-person cluster (and `kFloor = 5` would have dropped it).

**Integration (`test/integration/**`):**
- `POST /admin/social/constellation/recompute`: non-admin caller → 403; constellation-disabled
  project → 400; (where the harness has a graph driver) a stored explicit floor is honored on
  recompute. The by-space fallback path covers the no-GDS case.

## Phasing

- **Phase 1 (backend):** contract (type, default, helper, schema, resolver) + materializer wiring +
  force-recompute endpoint + all tests above + contract version bump + `CHANGELOG.md`. This alone
  fixes the demo (unconfigured → adaptive → floor 2) and makes the floor settable via API.
- **Phase 2 (admin UI):** the Settings → Social control + recompute button.

## Open questions

None blocking. Tier boundaries are intentionally easy to tune post-merge.
