# Adaptive, admin-tunable Weather K_W + denser demo seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Weather brightness saturation constant `K_W` adaptive to community size and admin-overridable (mirroring the Constellation k-floor), thread it coherently through all four brightness surfaces, and densify the demo seed so a warm small community reads *fine* with *sunny* hubs.

**Architecture:** `K_W` moves from a hard-coded module constant (`= 10`) to a value resolved per project as `cfg.weatherKW ?? adaptiveWeatherKW(memberCount)`, where `memberCount` comes from one shared cached resolver (`getCommunityMemberCount`, distinct graph participants). The pure brightness functions gain an explicit `kW` parameter so every call site must pass it; Weather, Constellation, Neighborhood, and Analytics all resolve the same `K_W`.

**Tech Stack:** TypeScript, Zod (`@agora-server/contract`), Hono (`@agora/api`), Neo4j/Cypher, Drizzle, Vitest, Vite/React (`@agora/admin`).

## Global Constraints

- `weatherKW` override bounds: integer in `[1, 50]`; out-of-range / non-integer / null → `null` (adaptive). LOCKSTEP: schema write bounds `[1,50]` must equal resolver read bounds.
- `adaptiveWeatherKW` step function (copy verbatim): `<15 → 2`, `<50 → 4`, `<200 → 6`, `else → 10`.
- `memberCount` = distinct users with ≥1 `INTERACTED` **or** `FRICTION` edge in the project (union of both endpoints), via the shared `getCommunityMemberCount` resolver. Same value across all four surfaces; resolved **once per project** (not per weather window).
- Brightness formula shape is unchanged: `pairBrightness = B_FLOOR + (1 - B_FLOOR)·sw·(1 - C_F·φ)`, `sw = w/(w+kW)`, `φ = f/(f+w+kW)`, `B_FLOOR = 0.15`, `C_F = 0.5`.
- `pnpm --filter @agora-server/contract build` must run after editing the contract, before typechecking `@agora/api`/`@agora/admin`.
- Verification gate before "done": `pnpm -r typecheck` and `pnpm test` (unit) green.
- Logging: shared `logger`, message-only on info/error, `{ err }` only on debug (never used in these pure paths).
- No DB migration — config lives in existing `projects.social_config` jsonb.

---

## File Structure

- `packages/contract/src/social.ts` — add `weatherKW` field/default, `resolveWeatherKW`, `adaptiveWeatherKW`, schema field, `resolveSocialConfig` wiring. (Task 1)
- `packages/contract/src/social.test.ts` — unit tests for the resolver + adaptive curve + override. (Task 1)
- `apps/api/src/lib/social-weather.ts` — parameterize `pairBrightness`/`personScoresFromPairs`/`weatherFromPairs`/`computeWeather` with `kW`; add `getCommunityMemberCount` + `invalidateCommunityMemberCount`; resolve+thread in `getSocialWeather`. (Task 2)
- `apps/api/src/lib/social-weather.test.ts` — `pairBrightness` monotonic in `kW` + reduces to legacy at `kW=10`; `weatherFromPairs` with `kW`. (Task 2)
- `apps/api/src/lib/social-config.ts` — add `weatherKW` to `transparencyView.decay`. (Task 2)
- `apps/api/src/routes/misc.ts` — call `invalidateCommunityMemberCount` on PATCH. (Task 2)
- `apps/api/src/lib/social-constellation.ts`, `social-analytics.ts`, `social-neighborhood.ts` (+ their `.test.ts`) — resolve+thread `kW`. (Task 3)
- `apps/admin/src/lib/social-weather-kw.ts` (+ `.test.ts`), `apps/admin/src/routes/settings/SocialGraphPanel.tsx` — admin control. (Task 4)
- `apps/api/scripts/seeds/seed.json` — densified manifest. (Task 5)
- `docs/AGORA-SOCIAL.md`, `docs/SOCIAL-GRAPH.md`, `CHANGELOG.md` — docs. (Task 6)

---

## Task 1: Contract — `weatherKW` field, resolver, adaptive curve, schema

**Files:**
- Modify: `packages/contract/src/social.ts` (interface ~L24-44, defaults ~L46-63, schema ~L80-99, resolver ~L145-170, plus new fns near `adaptiveConstellationFloor` ~L137)
- Test: `packages/contract/src/social.test.ts`

**Interfaces:**
- Produces:
  - `ResolvedSocialConfig.weatherKW: number | null`
  - `resolveWeatherKW(v: unknown): number | null`
  - `adaptiveWeatherKW(memberCount: number): number`
  - `socialConfigSchema` gains `weatherKW: z.number().int().min(1).max(50).nullish()`

- [ ] **Step 1: Write the failing tests**

Add to `packages/contract/src/social.test.ts` (import `resolveWeatherKW`, `adaptiveWeatherKW`, `resolveSocialConfig` as needed):

```ts
import { resolveWeatherKW, adaptiveWeatherKW } from "./social.js";

describe("adaptiveWeatherKW", () => {
  it("steps by community size", () => {
    expect(adaptiveWeatherKW(0)).toBe(2);
    expect(adaptiveWeatherKW(14)).toBe(2);
    expect(adaptiveWeatherKW(15)).toBe(4);
    expect(adaptiveWeatherKW(49)).toBe(4);
    expect(adaptiveWeatherKW(50)).toBe(6);
    expect(adaptiveWeatherKW(199)).toBe(6);
    expect(adaptiveWeatherKW(200)).toBe(10);
    expect(adaptiveWeatherKW(100000)).toBe(10);
  });
});

describe("resolveWeatherKW", () => {
  it("keeps an integer in [1,50]", () => {
    expect(resolveWeatherKW(1)).toBe(1);
    expect(resolveWeatherKW(3)).toBe(3);
    expect(resolveWeatherKW(50)).toBe(50);
  });
  it("null for absent/malformed/out-of-range/non-integer", () => {
    expect(resolveWeatherKW(null)).toBeNull();
    expect(resolveWeatherKW(undefined)).toBeNull();
    expect(resolveWeatherKW(0)).toBeNull();
    expect(resolveWeatherKW(51)).toBeNull();
    expect(resolveWeatherKW(2.5)).toBeNull();
    expect(resolveWeatherKW("3")).toBeNull();
  });
});

describe("resolveSocialConfig weatherKW", () => {
  it("defaults to null (adaptive)", () => {
    expect(resolveSocialConfig({}).weatherKW).toBeNull();
  });
  it("preserves a valid override and drops a bad one", () => {
    expect(resolveSocialConfig({ weatherKW: 3 }).weatherKW).toBe(3);
    expect(resolveSocialConfig({ weatherKW: 999 }).weatherKW).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agora-server/contract test -- social`
Expected: FAIL — `resolveWeatherKW`/`adaptiveWeatherKW` are not exported.

- [ ] **Step 3: Implement in `packages/contract/src/social.ts`**

Add `weatherKW: number | null;` to the `ResolvedSocialConfig` interface (after `frictionHalfLifeDays: number;` at ~L43):

```ts
  warmthHalfLifeDays: number;
  frictionHalfLifeDays: number;
  weatherKW: number | null;
}
```

Add to `COMMUNITY_DEFAULTS` (after `frictionHalfLifeDays: 14,` ~L62):

```ts
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
  weatherKW: null,
};
```

Add to `socialConfigSchema` (after the `warmthHalfLifeDays`/`frictionHalfLifeDays` fields ~L96-97):

```ts
  // LOCKSTEP: schema write bounds (min 1, max 50) must stay aligned with resolver read bounds (resolveWeatherKW: [1,50]); change both together.
  weatherKW: z.number().int().min(1).max(50).nullish(),
```

Add the two functions next to `adaptiveConstellationFloor` (~L142):

```ts
/** Resolve a stored Weather saturation constant. null/absent/malformed/out-of-[1,50] → null (adaptive,
 *  resolved at read time via adaptiveWeatherKW); integer in [1,50] → returned as-is. */
export function resolveWeatherKW(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 50) return null;
  return v;
}

/** The adaptive (default) Weather K_W for a project of `memberCount` participants. Smaller communities
 *  saturate faster (a warm tie is bright with less accumulated warmth); ≥200 uses the historically
 *  documented value of 10. Used when weatherKW is null. */
export function adaptiveWeatherKW(memberCount: number): number {
  if (memberCount < 15) return 2;
  if (memberCount < 50) return 4;
  if (memberCount < 200) return 6;
  return 10;
}
```

Wire into `resolveSocialConfig` (after the `frictionHalfLifeDays` line ~L169):

```ts
    warmthHalfLifeDays: intIn(r.warmthHalfLifeDays, d.warmthHalfLifeDays, 1, 365),
    frictionHalfLifeDays: intIn(r.frictionHalfLifeDays, d.frictionHalfLifeDays, 1, 365),
    weatherKW: resolveWeatherKW(r.weatherKW),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agora-server/contract test -- social`
Expected: PASS.

- [ ] **Step 5: Build the contract**

Run: `pnpm --filter @agora-server/contract build`
Expected: builds clean (api/admin consume its `dist/`).

- [ ] **Step 6: Commit**

```bash
git add packages/contract/src/social.ts packages/contract/src/social.test.ts
git commit -m "feat(social): add adaptive+overridable Weather K_W to contract"
```

---

## Task 2: Weather core — parameterize brightness + shared member-count resolver

**Files:**
- Modify: `apps/api/src/lib/social-weather.ts` (constant L14, `pairBrightness` L39-43, `personScoresFromPairs` L48-59, `weatherFromPairs` L62-68, `computeWeather` L172-176, `getSocialWeather` L184-205)
- Modify: `apps/api/src/lib/social-config.ts` (`transparencyView` ~L56)
- Modify: `apps/api/src/routes/misc.ts` (PATCH handler ~L242-243)
- Test: `apps/api/src/lib/social-weather.test.ts`

**Interfaces:**
- Consumes: `adaptiveWeatherKW`, `resolveWeatherKW` from `@agora-server/contract` (Task 1).
- Produces:
  - `pairBrightness(w: number, f: number, kW: number): number`
  - `personScoresFromPairs(pairs: WarmthPair[], kW: number): Map<string, number>`
  - `weatherFromPairs(pairs: WarmthPair[], kW: number): number | null`
  - `computeWeather(driver, projectId, cfg, asOfMs, kW): Promise<number | null>`
  - `getCommunityMemberCount(projectId: string, opts?: { driver?: Driver; nowMs?: number }): Promise<number>`
  - `invalidateCommunityMemberCount(projectId: string): void`
  - `DEFAULT_K_W = 10` (renamed from `K_W`)
  - `getSocialWeather` `opts` gains `memberCount?: number` (test seam)

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/lib/social-weather.test.ts`:

```ts
import { pairBrightness, weatherFromPairs, DEFAULT_K_W } from "./social-weather.js";

describe("pairBrightness kW parameter", () => {
  it("is brighter for a smaller kW at fixed w,f", () => {
    const w = 2, f = 0;
    expect(pairBrightness(w, f, 2)).toBeGreaterThan(pairBrightness(w, f, 10));
  });
  it("reduces to the legacy value at kW=10", () => {
    // legacy: 0.15 + 0.85 * (2/12) ≈ 0.2917
    expect(pairBrightness(2, 0, DEFAULT_K_W)).toBeCloseTo(0.15 + 0.85 * (2 / 12), 6);
  });
});

describe("weatherFromPairs kW parameter", () => {
  it("threads kW into brightness", () => {
    const pairs = [{ actor: "a", recipient: "b", w: 2, f: 0 }];
    expect(weatherFromPairs(pairs, 2)).toBeCloseTo(pairBrightness(2, 0, 2), 6);
    expect(weatherFromPairs([], 2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agora/api test -- social-weather`
Expected: FAIL — `DEFAULT_K_W` not exported / `pairBrightness` arity mismatch.

- [ ] **Step 3: Implement in `apps/api/src/lib/social-weather.ts`**

Add import at top (with the existing contract import):

```ts
import { adaptiveWeatherKW } from "@agora-server/contract";
```

Rename the constant (L14) and keep it as the documented large-community default:

```ts
export const DEFAULT_K_W = 10; // large-community saturation default; small communities use adaptiveWeatherKW
```

Change `pairBrightness` (L39-43) to take `kW`:

```ts
/** Dyadic brightness B(u,v) with the CAP + FLOOR guarantees, at saturation constant `kW`. */
export function pairBrightness(w: number, f: number, kW: number): number {
  const sw = w / (w + kW);
  const phi = f / (f + w + kW);
  return B_FLOOR + (1 - B_FLOOR) * sw * (1 - C_F * phi);
}
```

Change `personScoresFromPairs` (L48-59) to thread `kW`:

```ts
export function personScoresFromPairs(pairs: WarmthPair[], kW: number): Map<string, number> {
  const inbound = new Map<string, { sum: number; n: number }>();
  for (const p of pairs) {
    const acc = inbound.get(p.recipient) ?? { sum: 0, n: 0 };
    acc.sum += pairBrightness(p.w, p.f, kW);
    acc.n += 1;
    inbound.set(p.recipient, acc);
  }
  const out = new Map<string, number>();
  for (const [id, acc] of inbound) out.set(id, acc.sum / acc.n);
  return out;
}
```

Change `weatherFromPairs` (L62-68):

```ts
export function weatherFromPairs(pairs: WarmthPair[], kW: number): number | null {
  if (pairs.length === 0) return null;
  const scores = personScoresFromPairs(pairs, kW);
  let total = 0;
  for (const s of scores.values()) total += s;
  return total / scores.size;
}
```

Add the shared member-count resolver + Cypher (place after `fetchWarmthPairs`, ~L169):

```ts
// Distinct users participating in the project's warmth graph (≥1 INTERACTED or FRICTION edge, either
// direction). This is the community size that scales the adaptive K_W — it ignores lurkers who never
// interact. Rides scorer_interacted_project / scorer_friction_project indexes.
export const MEMBER_COUNT_CYPHER = `
MATCH (u:User)-[r:INTERACTED|FRICTION]-(v:User)
WHERE r.projectId = $projectId
RETURN count(DISTINCT u) AS n`;

const MEMBER_COUNT_TTL_MS = 30_000;
const memberCountCache = new Map<string, { n: number; at: number }>();

/** Distinct warmth-graph participants for a project, cached 30s (mirrors getSocialConfig). Returns 0
 *  when Neo4j is unconfigured (→ adaptiveWeatherKW(0) = smallest kW; harmless, weather is null anyway). */
export async function getCommunityMemberCount(
  projectId: string, opts: { driver?: Driver; nowMs?: number } = {},
): Promise<number> {
  const now = opts.nowMs ?? Date.now();
  const hit = memberCountCache.get(projectId);
  if (hit && now - hit.at < MEMBER_COUNT_TTL_MS) return hit.n;
  const driver = opts.driver ?? getNeo4j();
  if (!driver) return 0;
  const { records } = await driver.executeQuery(
    MEMBER_COUNT_CYPHER, { projectId }, { database: neo4jDatabase() },
  );
  const n = records.length ? toNum(records[0].get("n")) : 0;
  memberCountCache.set(projectId, { n, at: now });
  return n;
}

/** Drop a project's cached member count (call alongside invalidateSocialWeather on a config PATCH). */
export function invalidateCommunityMemberCount(projectId: string): void {
  memberCountCache.delete(projectId);
}
```

Change `computeWeather` (L172-176) to take `kW`:

```ts
export async function computeWeather(
  driver: Driver, projectId: string, cfg: HalfLives, asOfMs: number, kW: number,
): Promise<number | null> {
  return weatherFromPairs(await fetchWarmthPairs(driver, projectId, cfg, asOfMs), kW);
}
```

Widen the config type used by `getSocialWeather` to include `weatherKW`, and resolve `kW` once. Change the `HalfLives` type alias (L146) to also allow weatherKW where needed by adding a broader type near it:

```ts
type WeatherConfig = Pick<ResolvedSocialConfig, "warmthHalfLifeDays" | "frictionHalfLifeDays" | "weatherKW">;
```

Update `getSocialWeather` (L184-205) signature + body:

```ts
export async function getSocialWeather(
  projectId: string, cfg: WeatherConfig,
  opts: { driver?: Driver; nowMs?: number; memberCount?: number } = {},
): Promise<SocialWeather> {
  const now = opts.nowMs ?? Date.now();
  const hit = weatherCache.get(projectId);
  if (hit && now - hit.at < WEATHER_TTL_MS) return hit.payload;
  const driver = opts.driver ?? getNeo4j();
  if (!driver) throw new Error("neo4j read client is not configured");
  const memberCount = opts.memberCount ?? (await getCommunityMemberCount(projectId, { driver, nowMs: now }));
  const kW = cfg.weatherKW ?? adaptiveWeatherKW(memberCount);
  const [current, prior] = await Promise.all([
    computeWeather(driver, projectId, cfg, now, kW),
    computeWeather(driver, projectId, cfg, now - TREND_WINDOW_MS, kW),
  ]);
  const value = current == null ? null : Math.round(current * 100) / 100;
  const payload: SocialWeather = Object.freeze({
    value,
    band: weatherBand(value, hit?.payload.band),
    trend: current == null || prior == null ? null : Math.round((current - prior) * 1000) / 1000,
    asOf: new Date(now).toISOString(),
  });
  weatherCache.set(projectId, { payload, at: now });
  return payload;
}
```

(Ensure `ResolvedSocialConfig` is imported — it already is at L10.)

- [ ] **Step 4: Add `weatherKW` to transparency + PATCH invalidation**

In `apps/api/src/lib/social-config.ts`, `transparencyView` decay block (~L56):

```ts
    decay: { warmthHalfLifeDays: cfg.warmthHalfLifeDays, frictionHalfLifeDays: cfg.frictionHalfLifeDays, weatherKW: cfg.weatherKW },
```

In `apps/api/src/routes/misc.ts`, add the import and the invalidation call. Update the import at L22:

```ts
import { invalidateSocialWeather, invalidateCommunityMemberCount } from "../lib/social-weather.js";
```

And after L243:

```ts
    invalidateSocialConfig(c.var.projectId);
    invalidateSocialWeather(c.var.projectId); // half-life/enablement changes shouldn't wait out the 1h weather TTL
    invalidateCommunityMemberCount(c.var.projectId); // K_W override may change the effective saturation now
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @agora/api test -- social-weather`
Expected: PASS.
Run: `pnpm --filter @agora/api typecheck`
Expected: passes (Task 3 call sites may still error — if so, proceed to Task 3 and typecheck at the end of Task 3; run `pnpm --filter @agora/api test -- social-weather` here to confirm this task's tests pass).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/social-weather.ts apps/api/src/lib/social-weather.test.ts apps/api/src/lib/social-config.ts apps/api/src/routes/misc.ts
git commit -m "feat(social): resolve adaptive Weather K_W via shared member-count resolver"
```

---

## Task 3: Thread K_W through Constellation, Analytics, Neighborhood

**Files:**
- Modify: `apps/api/src/lib/social-constellation.ts` (L132-133), `.test.ts`
- Modify: `apps/api/src/lib/social-analytics.ts` (L141), `.test.ts`
- Modify: `apps/api/src/lib/social-neighborhood.ts` (`neighborhoodFromRows` L43-49, `getSocialNeighborhood` L107-134), `.test.ts`
- Test: the three `.test.ts` files above

**Interfaces:**
- Consumes: `personScoresFromPairs(pairs, kW)`, `pairBrightness(w,f,kW)`, `getCommunityMemberCount`, `adaptiveWeatherKW` (Tasks 1-2).
- Produces: `neighborhoodFromRows(rows: NeighborhoodRow[], kW: number)`; `getSocialNeighborhood` `opts` gains `memberCount?: number`.

- [ ] **Step 1: Write the failing test (neighborhood pure fn)**

In `apps/api/src/lib/social-neighborhood.test.ts`, update existing `neighborhoodFromRows` calls to pass `kW` and add:

```ts
import { neighborhoodFromRows } from "./social-neighborhood.js";
import { pairBrightness } from "./social-weather.js";

it("neighborhoodFromRows threads kW into dyadic brightness", () => {
  const rows = [{ userId: "x", tieKinds: ["follow"] as const, w: 2, f: 0 }];
  const out = neighborhoodFromRows(rows as any, 2);
  expect(out[0].brightness).toBeCloseTo(Math.round(pairBrightness(2, 0, 2) * 100) / 100, 6);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agora/api test -- social-neighborhood`
Expected: FAIL — `neighborhoodFromRows` arity mismatch.

- [ ] **Step 3: Implement neighborhood**

In `apps/api/src/lib/social-neighborhood.ts`, change `neighborhoodFromRows` (L43-49):

```ts
export function neighborhoodFromRows(
  rows: NeighborhoodRow[], kW: number,
): Array<{ userId: string; tieKinds: NeighborhoodTieKind[]; brightness: number }> {
  return rows
    .map((r) => ({ userId: r.userId, tieKinds: r.tieKinds, brightness: round2(pairBrightness(r.w, r.f, kW)) }))
    .sort((a, b) => b.brightness - a.brightness);
}
```

Update imports (L17) to add the resolver + adaptive fn:

```ts
import { pairBrightness, AGE_CUTOFF_HALF_LIVES, LN2, DAY_MS, getCommunityMemberCount } from "./social-weather.js";
import { adaptiveWeatherKW } from "@agora-server/contract";
```

Widen the `HalfLives` type alias (L19) to include `weatherKW`:

```ts
type HalfLives = Pick<ResolvedSocialConfig, "warmthHalfLifeDays" | "frictionHalfLifeDays" | "weatherKW">;
```

In `getSocialNeighborhood` (L107-141): add `memberCount?: number` to `opts`, resolve `kW`, pass to `neighborhoodFromRows`:

```ts
    fetchProfiles?: (ids: string[]) => Promise<Map<string, ProfileLite>>;
    memberCount?: number;
  } = {},
): Promise<SocialNeighborhood> {
```

After the driver null-check (~L123), before the query:

```ts
  const memberCount = opts.memberCount ?? (await getCommunityMemberCount(projectId, { driver, nowMs: now }));
  const kW = cfg.weatherKW ?? adaptiveWeatherKW(memberCount);
```

Change the `neighborhoodFromRows(rows)` call (L141) to `neighborhoodFromRows(rows, kW)`.

- [ ] **Step 4: Implement Constellation + Analytics**

In `apps/api/src/lib/social-constellation.ts`, update imports (L20) to include `getCommunityMemberCount` and `adaptiveWeatherKW`:

```ts
import {
  B_FLOOR, DAY_MS, fetchWarmthPairs, personScoresFromPairs, weatherBand, getCommunityMemberCount,
} from "./social-weather.js";
```

Ensure `adaptiveWeatherKW` is in the `@agora-server/contract` import (it already imports `adaptiveConstellationFloor` at L10):

```ts
  adaptiveConstellationFloor,
  adaptiveWeatherKW,
```

Change the `personScoresFromPairs` call (L132) to resolve+thread `kW` (note the `getCommunityMemberCount(projectId, { driver, nowMs })` signature — projectId first, driver in opts):

```ts
  const memberCount = await getCommunityMemberCount(projectId, { driver, nowMs: now });
  const kW = cfg.weatherKW ?? adaptiveWeatherKW(memberCount);
  const sP = personScoresFromPairs(await fetchWarmthPairs(driver, projectId, cfg, now), kW);
```

In `apps/api/src/lib/social-analytics.ts`, update the import (L22) and `computeEngagement` (L138-143):

```ts
import { DAY_MS, fetchWarmthPairs, personScoresFromPairs, getCommunityMemberCount } from "./social-weather.js";
```

Add `adaptiveWeatherKW` to the existing `@agora-server/contract` import in that file (add the symbol to whichever contract import line exists; if none imports from contract, add `import { adaptiveWeatherKW } from "@agora-server/contract";`).

```ts
async function computeEngagement(
  driver: Driver, projectId: string, cfg: ResolvedSocialConfig, now: number,
): Promise<EngagementPayload> {
  const memberCount = await getCommunityMemberCount(projectId, { driver, nowMs: now });
  const kW = cfg.weatherKW ?? adaptiveWeatherKW(memberCount);
  const sP = personScoresFromPairs(await fetchWarmthPairs(driver, projectId, cfg, now), kW);
  return { members: [...sP.entries()].map(([userId, v]) => ({ userId, sP: round4(v) })) };
}
```

- [ ] **Step 5: Update existing tests for new signatures**

In `social-constellation.test.ts` and `social-analytics.test.ts`, any direct `personScoresFromPairs(pairs)` call becomes `personScoresFromPairs(pairs, 10)` (or the kW under test). In `social-neighborhood.test.ts`, any `getSocialNeighborhood(..., opts)` unit test using a stub driver must pass `memberCount` in `opts` so it doesn't invoke the count query against the stub (e.g. `{ driver: stub, memberCount: 12, ... }`).

- [ ] **Step 6: Run tests + full typecheck**

Run: `pnpm --filter @agora/api test`
Expected: PASS.
Run: `pnpm --filter @agora-server/contract build && pnpm -r typecheck`
Expected: passes across contract + api + admin.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/social-constellation.ts apps/api/src/lib/social-analytics.ts apps/api/src/lib/social-neighborhood.ts apps/api/src/lib/social-constellation.test.ts apps/api/src/lib/social-analytics.test.ts apps/api/src/lib/social-neighborhood.test.ts
git commit -m "feat(social): thread adaptive K_W through constellation, neighborhood, analytics"
```

---

## Task 4: Admin — tunable Weather K_W control

**Files:**
- Create: `apps/admin/src/lib/social-weather-kw.ts`, `apps/admin/src/lib/social-weather-kw.test.ts`
- Modify: `apps/admin/src/routes/settings/SocialGraphPanel.tsx` (import ~L26, add control in the numeric-tuning `CardContent` after the k-floor block ~L360)

**Interfaces:**
- Consumes: `weatherKW` on the resolved config (from `view.effective.weatherKW`) + `draft.weatherKW`.
- Produces: `KW_MIN=1`, `KW_MAX=50`, `clampWeatherKW(raw: number): number`, `ADAPTIVE_KW_TIERS`.

- [ ] **Step 1: Write the failing test**

`apps/admin/src/lib/social-weather-kw.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clampWeatherKW, KW_MIN, KW_MAX, ADAPTIVE_KW_TIERS } from "./social-weather-kw";
import { adaptiveWeatherKW } from "@agora-server/contract";

describe("clampWeatherKW", () => {
  it("clamps to [1,50] and rounds", () => {
    expect(clampWeatherKW(0)).toBe(KW_MIN);
    expect(clampWeatherKW(99)).toBe(KW_MAX);
    expect(clampWeatherKW(3.4)).toBe(3);
    expect(clampWeatherKW(NaN)).toBe(KW_MIN);
  });
});

describe("ADAPTIVE_KW_TIERS", () => {
  it("stays in lockstep with the contract curve", () => {
    expect(adaptiveWeatherKW(14)).toBe(2);
    expect(adaptiveWeatherKW(15)).toBe(4);
    expect(adaptiveWeatherKW(50)).toBe(6);
    expect(adaptiveWeatherKW(200)).toBe(10);
    expect(ADAPTIVE_KW_TIERS.map((t) => t.kW)).toEqual([2, 4, 6, 10]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agora/admin test -- social-weather-kw`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helper**

`apps/admin/src/lib/social-weather-kw.ts`:

```ts
/** Weather saturation constant K_W override bounds (mirrors the contract's resolveWeatherKW [1,50]). */
export const KW_MIN = 1;
export const KW_MAX = 50;

/** Clamp a raw numeric input to a valid explicit K_W: integer in [1, 50].
 *  Non-finite (NaN, ±Infinity) → the minimum. */
export function clampWeatherKW(raw: number): number {
  if (!Number.isFinite(raw)) return KW_MIN;
  return Math.max(KW_MIN, Math.min(KW_MAX, Math.round(raw)));
}

/** Human-readable rows describing the adaptive curve — kept in lockstep with the contract's
 *  adaptiveWeatherKW (asserted in social-weather-kw.test.ts). Purely for display. */
export const ADAPTIVE_KW_TIERS = [
  { range: "< 15", kW: 2 },
  { range: "15–49", kW: 4 },
  { range: "50–199", kW: 6 },
  { range: "≥ 200", kW: 10 },
] as const;
```

- [ ] **Step 4: Add the control to `SocialGraphPanel.tsx`**

Update the import at L26:

```ts
import { clampKFloor, ADAPTIVE_KFLOOR_TIERS } from "../../lib/social-kfloor";
import { clampWeatherKW, ADAPTIVE_KW_TIERS } from "../../lib/social-weather-kw";
```

After the k-floor IIFE block closes (immediately before the half-life fields; ~L360, inside the same `CardContent`), add a parallel block:

```tsx
          {/* ── Weather K_W: adaptive / fixed ─────────────────────────────────────────────────── */}
          {(() => {
            const kwMode = draft.weatherKW === null || draft.weatherKW === undefined ? "adaptive" : "fixed";
            return (
              <div className="sm:col-span-3 space-y-3">
                <Field
                  label="Weather sensitivity (K_W)"
                  hint="How much accumulated warmth a relationship needs to read as 'bright'. Adaptive is recommended — it lowers the bar for smaller communities so a warm small community doesn't read as stormy. A lower fixed value makes Weather warmer; higher makes it cooler."
                >
                  <select
                    className={selectCls}
                    value={kwMode}
                    disabled={disabled}
                    onChange={(e) => {
                      if (e.target.value === "adaptive") set("weatherKW", null);
                      else set("weatherKW", view.effective.weatherKW ?? 4);
                    }}
                  >
                    <option value="adaptive">Adaptive (recommended)</option>
                    <option value="fixed">Fixed value</option>
                  </select>

                  {kwMode === "fixed" && (
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      step={1}
                      value={draft.weatherKW ?? ""}
                      disabled={disabled}
                      onChange={(e) => set("weatherKW", clampWeatherKW(Number(e.target.value)))}
                    />
                  )}

                  {kwMode === "adaptive" && (
                    <div className="rounded-lg border border-border/60 bg-surface-2/50 px-3 py-2 space-y-1.5">
                      <p className="text-xs font-medium text-muted mb-1.5">Adaptive K_W by community size</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Community size</span>
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">K_W</span>
                        {ADAPTIVE_KW_TIERS.map((tier) => (
                          <Fragment key={tier.range}>
                            <span className="text-xs text-muted">{tier.range}</span>
                            <span className="text-xs text-muted">{tier.kW}</span>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )}
                </Field>
              </div>
            );
          })()}
```

(`Fragment`, `Field`, `Input`, `selectCls`, `draft`, `set`, `view`, `disabled` are already in scope in this file — used by the k-floor block above.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @agora/admin test -- social-weather-kw`
Expected: PASS.
Run: `pnpm --filter @agora/admin typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/lib/social-weather-kw.ts apps/admin/src/lib/social-weather-kw.test.ts apps/admin/src/routes/settings/SocialGraphPanel.tsx
git commit -m "feat(admin): Weather K_W adaptive/fixed control in social settings"
```

---

## Task 5: Densify the demo seed → warm with range

**Files:**
- Modify: `apps/api/scripts/seeds/seed.json` (add `posts`, `reactions`, some `comments`)
- Reference (read-only): `apps/api/scripts/seeds/03-seed-engine.mjs` (the engine that applies it)

**Interfaces:**
- Consumes: adaptive `K_W` (Tasks 1-3) — with 14 participants the resolved `K_W = 2`.
- Produces: a `seed.json` whose materialized graph yields Weather ∈ `[0.60, 0.68]` (fine) with ≥1 sunny recipient and ≥1 overcast recipient.

**Design math (K_W=2):** `pairBrightness(w,0,2)`: `w=1→0.43`, `w=2→0.58`, `w=3→0.66`, `w=5→0.75`. Weather is the mean over recipients of their mean inbound brightness. Target: most active pairs at `w≈2–3`, Alice's inbound pairs at `w≈4–5` (sunny hub), one recipient left at `w≈1` (overcast corner). Warm reaction sentiments: `love/upvote=1.0`, `like=0.8`. A pair's `w` accumulates across **distinct** items of the recipient (reactions toggle one-per-item), so hubs need multiple posts.

- [ ] **Step 1: Add hub content + clustered warmth to `seed.json`**

Add these **posts** to the `posts` array (gives hubs content to warm on):

```json
    { "handle": "darkroom",   "author": "alice", "space": "photography", "title": "Developing tri-x in the kitchen sink", "content": "Stand development, one hour, minimal agitation. The negatives came out with this gorgeous gentle contrast." },
    { "handle": "coffeewalk",  "author": "alice", "title": "Morning coffee walks are the best ritual", "content": "Same loop, same bench, different light every day. Fifteen minutes that reset the whole morning." },
    { "handle": "espresso",    "author": "bob",  "space": "food", "title": "Dialing in the espresso grind", "content": "Two clicks finer killed the sour shot. Nine bar, 1:2 in twenty-eight seconds. Chef's kiss." },
    { "handle": "crumb",       "author": "cara", "space": "food", "title": "Agnes's first crumb shot", "content": "Open, glossy, and just the right chew. Seven days of feeding paid off in one slice." },
    { "handle": "summit",      "author": "dan",  "space": "outdoors", "title": "Sunrise from the ridge", "content": "Up at four, on the ridge by six, coffee from the thermos as the valley went gold. Worth every cold step." }
```

Add these **comments** (warm comments carry positive relationship sentiment → extra `w`):

```json
    { "handle": "c21", "author": "bob",  "entity": "darkroom",   "content": "Stand development is witchcraft and I love the results here." },
    { "handle": "c22", "author": "hana", "entity": "darkroom",   "content": "That gentle contrast is exactly what I chase. Beautiful negs." },
    { "handle": "c23", "author": "evy",  "entity": "coffeewalk", "content": "This is the most wholesome ritual. Stealing it." },
    { "handle": "c24", "author": "cara", "entity": "espresso",   "content": "1:2 in 28s is the sweet spot. Nicely dialed." },
    { "handle": "c25", "author": "lena", "entity": "crumb",      "content": "That crumb is textbook. Agnes is thriving." },
    { "handle": "c26", "author": "june", "entity": "summit",     "content": "The thermos coffee at sunrise detail is everything." }
```

Add these **reactions** to cluster warmth. Alice becomes a bright inbound hub (many warm actors across her 3 posts + comments); active pairs elsewhere reach `w≈2–3`; **leave `finn`/`vinyl` and `ivan`/`keyboard` lightly reacted** (the overcast corner):

```json
    { "by": "bob",  "on": { "post": "darkroom" },   "type": "love" },
    { "by": "hana", "on": { "post": "darkroom" },   "type": "love" },
    { "by": "evy",  "on": { "post": "darkroom" },   "type": "upvote" },
    { "by": "cara", "on": { "post": "coffeewalk" }, "type": "love" },
    { "by": "evy",  "on": { "post": "coffeewalk" }, "type": "love" },
    { "by": "gia",  "on": { "post": "coffeewalk" }, "type": "like" },
    { "by": "hana", "on": { "post": "coffeewalk" }, "type": "upvote" },
    { "by": "alice","on": { "post": "coldbrew" },   "type": "love" },
    { "by": "alice","on": { "post": "espresso" },   "type": "love" },
    { "by": "cara", "on": { "post": "espresso" },   "type": "upvote" },
    { "by": "lena", "on": { "post": "espresso" },   "type": "love" },
    { "by": "bob",  "on": { "post": "crumb" },      "type": "love" },
    { "by": "lena", "on": { "post": "crumb" },      "type": "love" },
    { "by": "kofi", "on": { "post": "crumb" },      "type": "upvote" },
    { "by": "june", "on": { "post": "summit" },     "type": "love" },
    { "by": "hana", "on": { "post": "summit" },     "type": "love" },
    { "by": "gia",  "on": { "post": "summit" },     "type": "upvote" },
    { "by": "cara", "on": { "post": "filmvscam" },  "type": "love" },
    { "by": "hana", "on": { "post": "coffeewalk" }, "type": "love" },
    { "by": "bob",  "on": { "comment": "c12" },     "type": "upvote" },
    { "by": "evy",  "on": { "comment": "c12" },     "type": "love" }
```

- [ ] **Step 2: Reset to a clean stack and re-seed**

The graph/DB must be clean (03-seed-engine is not idempotent; reactions toggle). With the dev stack up (`docker compose -f docker-compose.dev.yml --profile scorer --profile supabase up` + host `pnpm dev`):

```bash
cd apps/api
# clean DB + fixtures:
node scripts/genesis.mjs --force
# wipe the graph (keep constraints/indexes):
PW=$(grep -E '^NEO4J_AUTH=' ../../.env | head -1 | cut -d= -f2- | cut -d/ -f2-)
docker exec agora-dev-neo4j-1 cypher-shell -u neo4j -p "$PW" -d agora-graph "MATCH (n) DETACH DELETE n;"
# seed the manifest world (00-03 + content):
pnpm seed
# wait for the scorer to drain pgmq (watch until queue_length = 0):
URL=$(grep -E '^DATABASE_URL=' ../../.env | head -1 | cut -d= -f2-)
psql "$URL" -tAc "select queue_length from pgmq.metrics('scorer_jobs');"
```

- [ ] **Step 3: Recompute Weather and verify the band**

Dump the INTERACTED edges from the live graph and recompute Weather offline (deterministic for reactions). Run:

```bash
PW=$(grep -E '^NEO4J_AUTH=' ../../.env | head -1 | cut -d= -f2- | cut -d/ -f2-)
docker exec agora-dev-neo4j-1 cypher-shell -u neo4j -p "$PW" -d agora-graph --format plain \
"MATCH (a:User)-[r:INTERACTED]->(b:User) WHERE r.projectId='11111111-1111-1111-1111-111111111111' AND r.sentiment IS NOT NULL AND r.sentiment<>0 RETURN a.id,b.id,r.sentiment,(timestamp()-r.at)/86400000.0;" > /tmp/interacted.csv
```

Then compute with the exact formula at `K_W=2` (14 participants):

```bash
python3 - <<'PY'
import csv, math
from collections import defaultdict
LN2=math.log(2); WH=30.0; K_W=2; B=0.15; C=0.5
w=defaultdict(float); f=defaultdict(float)
with open('/tmp/interacted.csv') as fh:
    for row in csv.reader(fh):
        if len(row)<4: continue
        try: a,b,s,age=row[0].strip('" '),row[1].strip('" '),float(row[2]),float(row[3])
        except ValueError: continue
        if s>0: w[(a,b)]+=s*math.exp(-LN2*age/WH)
        elif s<0: f[(a,b)]+=-s*math.exp(-LN2*age/14.0)
def bright(wv,fv):
    sw=wv/(wv+K_W); phi=fv/(fv+wv+K_W); return B+(1-B)*sw*(1-C*phi)
pairs=set(list(w)+list(f)); inb=defaultdict(list)
for (a,b) in pairs: inb[b].append(bright(w[(a,b)],f[(a,b)]))
Sp={b:sum(v)/len(v) for b,v in inb.items()}
val=sum(Sp.values())/len(Sp)
bands=[0.35,0.55,0.75]; names=['stormy','overcast','fine','sunny']
print('recipients:',len(Sp))
print('sunny:', sorted([k[:8] for k,v in Sp.items() if v>=0.75]))
print('overcast/stormy:', sorted([k[:8] for k,v in Sp.items() if v<0.55]))
print(f'WEATHER={val:.4f} -> {names[sum(1 for x in bands if val>=x)]}')
PY
```

Expected: `WEATHER` ∈ `[0.60, 0.68]` → `fine`, with at least one `sunny` recipient (Alice) and at least one `overcast` recipient (finn/ivan). If below 0.60, add 1-2 more `love` reactions on hub posts from distinct actors; if above 0.68 or the cool corner disappears, remove a reaction from finn/ivan. Re-run Step 2-3 after each tweak (remember: full reset, not incremental).

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/seeds/seed.json
git commit -m "feat(seed): densify demo warmth so Weather reads fine with sunny hubs"
```

---

## Task 6: Docs + CHANGELOG

**Files:**
- Modify: `docs/AGORA-SOCIAL.md` (§11 warmth math — K_W currently "locked")
- Modify: `docs/SOCIAL-GRAPH.md` (§5 config, §3 weather)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: Update `docs/AGORA-SOCIAL.md` §11**

Find the passage stating `K_W` is a locked design constant "deliberately NOT in social_config". Replace with a description of the new behavior: `K_W` is the warmth saturation constant; it now defaults to an **adaptive** value scaled by community size (`<15→2, <50→4, <200→6, else→10`, the historical value) and can be **overridden** per project via `social_config.weatherKW` (integer 1–50, admin Settings → Social Graph). Note that the same resolved `K_W` is applied across Weather, Constellation tint, Neighborhood, and engagement analytics for coherence, and that `memberCount` = distinct warmth-graph participants.

- [ ] **Step 2: Update `docs/SOCIAL-GRAPH.md`**

In §5 (config), add `weatherKW` to the config field list (default null = adaptive; override 1–50). In §3 (weather), note the saturation constant is adaptive/overridable and cross-surface consistent.

- [ ] **Step 3: Update `CHANGELOG.md`**

Under `## [Unreleased]`:

```markdown
### Added
- Social: `weatherKW` per-project config (admin Settings → Social Graph) — override the Weather saturation constant, or leave blank for the size-adaptive default.

### Changed
- Social: the Weather brightness saturation constant `K_W` is now adaptive to community size (small communities saturate faster, so a warm small community reads "fine"/"sunny" instead of "stormy") and admin-overridable. The same resolved `K_W` is applied across Weather, Constellation, Neighborhood, and engagement analytics. Demo seed densified to exercise the warm range.
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm -r typecheck && pnpm test`
Expected: green (docs don't affect this, but confirm the whole change set still passes before wrapping).

```bash
git add docs/AGORA-SOCIAL.md docs/SOCIAL-GRAPH.md CHANGELOG.md
git commit -m "docs(social): document adaptive/overridable Weather K_W"
```

---

## Self-Review Notes (author)

- **Spec coverage:** contract field/resolver/adaptive (T1) · thread all 4 surfaces + shared resolver + transparency + invalidation (T2/T3) · admin control (T4) · seed densification + empirical verify (T5) · docs (T6). All spec sections mapped.
- **Type consistency:** `pairBrightness(w,f,kW)`, `personScoresFromPairs(pairs,kW)`, `weatherFromPairs(pairs,kW)`, `computeWeather(...,kW)`, `neighborhoodFromRows(rows,kW)`, `getCommunityMemberCount(projectId,opts)` used consistently across tasks; `DEFAULT_K_W` replaces `K_W`.
- **Empirical caveat:** Task 5 counts are a concrete starting set tuned by the verification loop; the target is a band, not a single value (absorbs Haiku comment-sentiment variance).
