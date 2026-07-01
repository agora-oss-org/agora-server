# Adaptive, admin-tunable Weather `K_W` + denser demo seed

**Date:** 2026-06-30
**Status:** Approved (brainstorm) — ready for implementation plan
**Related:** `docs/AGORA-SOCIAL.md §11` (warmth math), `docs/SOCIAL-GRAPH.md §3/§7`,
the Constellation adaptive k-floor (`packages/contract/src/social.ts` `adaptiveConstellationFloor`,
git `73ae4df`/`7be791b`) — this mirrors that pattern for the Weather saturation constant.

## Problem

Community Weather renders **stormy** for small communities even when interactions are warm. Verified
empirically on the full `seed.mjs` graph (14 users, 58 `INTERACTED` edges, 38 directed pairs):

```
WEATHER value = 0.2275  ->  BAND = stormy
```

Every recipient's per-person score `S_p` sits at 0.16–0.27, hugging the brightness floor
`B_FLOOR = 0.15`. The cause is the **warmth saturation constant `K_W = 10`** in
`apps/api/src/lib/social-weather.ts`:

```
pairBrightness(w, f) = B_FLOOR + (1 - B_FLOOR) · sw · (1 - C_F · φ),  sw = w / (w + K_W)
```

`K_W = 10` means a directed pair needs decayed warmth `w ≈ 3` to read *overcast*, `w ≈ 9` for *fine*,
`w ≈ 24` for *sunny*. In the seed, per-pair `w` maxes at **2.75** (most pairs ≈ 1–2), because a small
community simply doesn't accumulate dozens of interactions per pair. `K_W = 10` is scaled for a busy
community; it is the wrong bar for a small one.

Two facts were established with the real graph data:

- **Pure seeding can't fix it.** Each user authors ~1 post + ~2 comments, so no pair can realistically
  accumulate `w > ~3`; the full seed caps around *overcast* no matter how warm the sentiment is.
- **Tuning `K_W` alone caps at *fine*.** A sweep on the current seed: `K_W=3 → 0.35 (overcast)`,
  `K_W=1 → 0.53 (overcast)`, `K_W=0.5 → 0.64 (fine)`; never *sunny*.

So the fix is **both**: make `K_W` adaptive to community size (+ admin-overridable), **and** densify the
seed so a genuinely warm small community reads *fine* with *sunny* hubs.

The Constellation already solved the identical small-community problem with an adaptive, overridable
k-floor. Weather never got the equivalent. This spec brings Weather (and the other brightness surfaces)
to parity.

## Goals

- A warm small community reads **fine/sunny**, a cold one still reads **stormy** — the signal is
  preserved, only the *scale* is corrected for community size.
- `K_W` is **admin-tunable** exactly like the Constellation k-floor: a fixed value, or blank for an
  adaptive default.
- Brightness is **coherent across all four garden surfaces** — a pair that Weather treats as bright is
  equally bright in the Neighborhood, Constellation tint, and engagement analytics.
- The demo `seed.json` world reads **≈ 0.60–0.68 (fine)** with a couple of sunny hub users and one
  cooler corner (dynamic range, not saccharine all-sunny).

## Non-goals

- No change to the brightness formula shape (`B_FLOOR`, `C_F`, the `sw`/`φ` structure stay as documented).
- No change to decay half-lives, band bounds, or hysteresis.
- Admin does **not** tune the adaptive *curve breakpoints* — only the single `K_W` override (YAGNI; the
  curve is a sensible default, the override is the escape hatch, mirroring k-floor).
- No new DB migration (config lives in the existing `projects.social_config` jsonb).

## Design

### 1. Contract — `packages/contract/src/social.ts`

Mirror the k-floor triplet (`constellationKFloor` / `resolveKFloor` / `adaptiveConstellationFloor`).

- **Field** on `ResolvedSocialConfig` and defaults:
  ```ts
  weatherKW: number | null;   // default: null  (=> adaptive, resolved at read time)
  ```
- **Write schema** (`socialConfigSchema`):
  ```ts
  weatherKW: z.number().int().min(1).max(50).nullish(),
  ```
  `// LOCKSTEP:` comment tying the schema write bounds `[1,50]` to the resolver read bounds, matching
  the existing k-floor lockstep note.
- **Resolver** — `resolveWeatherKW(v: unknown): number | null`:
  null/absent/malformed/out-of-`[1,50]` → `null` (adaptive); an integer in `[1,50]` → returned as-is.
  (No hard floor raise like k-floor's `Math.max(2,…)` — any value ≥1 is meaningful for `K_W`.)
- **Adaptive default** — `adaptiveWeatherKW(memberCount: number): number` step function:
  ```
  memberCount < 15   -> 2
  memberCount < 50   -> 4
  memberCount < 200  -> 6
  else               -> 10   // the historically-documented value
  ```
- Wire `weatherKW: resolveWeatherKW(r.weatherKW)` into `resolveSocialConfig`, and surface it in
  `transparencyView` under `decay` (or a sibling key) so members see the active saturation setting,
  consistent with existing transparency of half-lives.

### 2. Read surfaces — thread one community-wide `K_W`

`K_W` is currently the module constant `K_W = 10` in `social-weather.ts`, consumed by four surfaces:

| File | Symbol used | Role |
|---|---|---|
| `lib/social-weather.ts` | `pairBrightness`, `personScoresFromPairs`, `weatherFromPairs` | Weather |
| `lib/social-constellation.ts` | `personScoresFromPairs` | cluster tint |
| `lib/social-neighborhood.ts` | `pairBrightness` | dyadic brightness |
| `lib/social-analytics.ts` | `personScoresFromPairs` | engagement scores |

**Change the pure functions to take `kW` as an explicit parameter** (remove reliance on the module
constant for the value; keep a `DEFAULT_K_W = 10` export only if a call site or test wants the legacy
default):

```ts
export function pairBrightness(w: number, f: number, kW: number): number
export function personScoresFromPairs(pairs: WarmthPair[], kW: number): Map<string, number>
export function weatherFromPairs(pairs: WarmthPair[], kW: number): number | null
```

**Community-size source (one resolver, all surfaces).** `K_W` must be identical everywhere for
coherence, so **all four surfaces use one shared cached resolver** rather than each deriving its own
count — `getCommunityMemberCount(projectId): Promise<number>`, keyed by project with the same 30s-cache
shape as `getSocialConfig`, and invalidated alongside the config/weather caches on
`PATCH /settings/social`.

- **Definition:** the count of **distinct users participating in the project's warmth graph** — users
  with ≥1 `INTERACTED` **or** `FRICTION` edge in the project (union of both endpoints). Rationale: it
  ignores lurkers (who never interact and would wrongly inflate the bar) and matches how the
  Constellation derives `memberCount` from `userIds.length` of the graph projection.
- **Backing query:** a cheap Cypher count of distinct participants over `INTERACTED`+`FRICTION` scoped
  by `projectId` (union both endpoints, `count(distinct …)`), rising on the existing
  `scorer_interacted_project` / `scorer_friction_project` indexes.
- **Not** derived from the weather `fetchWarmthPairs` result: that set is filtered to
  `sentiment <> 0`, so its participant count would diverge from the other surfaces. The shared resolver
  is the single source of truth — this is deliberate to eliminate cross-surface drift.

**Resolution at each surface:**
```ts
const kW = cfg.weatherKW ?? adaptiveWeatherKW(memberCount);
```
resolved once, then threaded into the pure functions.

`getSocialWeather` already computes two windows (now, now−7d) and caches per project for 1h; `K_W`
resolves per computation from the pairs of that window (member count is stable enough that the two
windows agree in practice). The `PATCH /settings/social` handler must continue to call
`invalidateSocialWeather` (and `invalidateSocialConfig`) so a changed override takes effect promptly;
add the shared community-size cache to that invalidation if it is introduced.

### 3. Admin — tunable control (parity with k-floor)

- **API:** no route code needed — `PATCH /settings/social` overlays `social_config` jsonb generically;
  the new field flows through `socialConfigSchema` → `resolveSocialConfig`.
- **Admin frontend:**
  - New helper `apps/admin/src/lib/social-weather-kw.ts` (+ `.test.ts`) mirroring
    `lib/social-kfloor.ts` — parse/format the "adaptive vs fixed" input, clamp to `[1,50]`.
  - Add a **"Weather sensitivity (K_W)"** control to `apps/admin/src/routes/settings/SocialGraphPanel.tsx`:
    blank = "Adaptive (default)", or a fixed integer `[1,50]`. Show the effective value (from the
    resolved config / transparency) the way the k-floor control shows its effective floor.

### 4. Seed densification — `apps/api/scripts/seeds/seed.json`

Goal: with adaptive `K_W = 2` (14 graph participants < 15), reach Weather **≈ 0.60–0.68 (fine)** with a
couple of *sunny* hub recipients and one *overcast* corner. With `K_W = 2`, `pairBrightness` per pair:
`w=1 → 0.43`, `w=2 → 0.58`, `w=3 → 0.66`, `w=5 → 0.75`. So the lever is: bring most **active pairs to
`w ≈ 2–3`** (not spread new thin pairs), and a few hub pairs to `w ≈ 5`.

- Add a handful of posts for hub/central users (esp. Alice) so there is content for pairs to warm on
  (the `w` accumulates across *distinct* items of the recipient — reactions toggle one-per-item).
- Cluster additional warm reactions + warm comments so chosen active pairs reach `w ≈ 2–3`; make Alice
  a bright inbound hub (multiple warm actors, each hitting several of her items) → *sunny*.
- Leave one relationship/corner deliberately light (a single interaction) so it reads *overcast* —
  preserves visible dynamic range.
- Keep the existing negative/neutral touches (the `downvote`, the `sad`) so friction/neutral handling
  stays represented.
- Constraint: `03-seed-engine.mjs` is **not idempotent** and reactions **toggle** — the densified
  manifest is still a run-once-on-clean-DB artifact (documented already). No engine change required;
  this is pure manifest data.

Exact counts are tuned empirically against the live stack (Neo4j + scorer + API are up): after seeding,
recompute Weather and adjust until it lands in `[0.60, 0.68]` with the intended hub/corner spread.

### 5. Docs + tests

- **Docs:** `docs/AGORA-SOCIAL.md §11` (currently states `K_W` is "locked" / "deliberately NOT in
  social_config") — update to describe adaptive + overridable `K_W`; `docs/SOCIAL-GRAPH.md §5` (config)
  + §3 (weather); admin settings doc if present; `CHANGELOG.md` under `[Unreleased]` (Changed: Weather
  saturation now adaptive to community size + admin-overridable; Added: `weatherKW` config).
- **Unit tests** (pure, no DB — `src/**/*.test.ts`, `packages/contract`):
  - `adaptiveWeatherKW` — each step boundary (14/15, 49/50, 199/200, ≥200).
  - `resolveWeatherKW` — null/absent/malformed/out-of-range → null; in-range integer preserved;
    non-integer/`>50`/`<1` → null.
  - `pairBrightness(w,f,kW)` — monotonic decreasing in `kW` (smaller `kW` ⇒ brighter for fixed w,f);
    reduces to the legacy value at `kW=10`.
  - Override-beats-adaptive: `cfg.weatherKW` set ⇒ adaptive ignored.
  - Updated signatures in existing weather/constellation tests (the DB-backed
    `getCommunityMemberCount` resolver is covered by integration, not unit, tests).
  - Admin `social-weather-kw.ts` helper test (parse/format/clamp), mirroring `social-kfloor.test.ts`.

## Blast radius / files

- `packages/contract/src/social.ts` (+ `social.test.ts`) — field, resolver, adaptive fn, wiring.
- `apps/api/src/lib/social-weather.ts` (+ test) — parameterize pure fns; resolve+thread `kW`;
  new shared `getCommunityMemberCount(projectId)` cached resolver (+ its cache invalidation).
- `apps/api/src/lib/social-constellation.ts`, `social-neighborhood.ts`, `social-analytics.ts` (+ tests)
  — resolve+thread `kW` via `getCommunityMemberCount`.
- `apps/admin/src/lib/social-weather-kw.ts` (+ test), `apps/admin/src/routes/settings/SocialGraphPanel.tsx`.
- `apps/api/scripts/seeds/seed.json` — densified manifest.
- Docs: `AGORA-SOCIAL.md`, `SOCIAL-GRAPH.md`, `CHANGELOG.md`.

## Risks

- **Cross-surface consistency** — the whole point is one shared `K_W`; if a surface forgets to thread it
  (or uses a different member count), brightness diverges. Mitigation: remove the module-constant *value*
  path so every call site must pass `kW` explicitly (a missing arg is a type error), and assert the
  shared community-size source.
- **Two-window `K_W` drift** in `getSocialWeather` — the now vs now−7d computations must use the *same*
  `K_W`, or the trend delta is noisy. Mitigation: the shared `getCommunityMemberCount` resolver returns
  one project-level count (not per-window), so both windows resolve the identical `K_W`.
- **Seed tuning is empirical** — counts are dialed against the live graph; the target band is a range,
  not a single value, to absorb Haiku comment-sentiment variance.

## Verification

- `pnpm -r typecheck` and `pnpm test` (unit) green.
- Re-seed the clean stack, recompute Weather from the real graph, confirm band ∈ *fine* (≈0.60–0.68)
  with ≥1 *sunny* recipient and ≥1 *overcast* recipient.
- Admin: set a fixed `weatherKW`, confirm Weather recomputes to the expected band; clear it, confirm it
  returns to the adaptive value.
