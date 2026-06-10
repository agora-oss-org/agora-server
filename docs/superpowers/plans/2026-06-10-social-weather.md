# Community Weather (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first Garden surface — `GET /v7/:projectId/social/weather`, a single aggregate community-warmth scalar computed live from Layer-1 Neo4j `INTERACTED` edges, plus an env-gated Neo4j read client and an operator dashboard card.

**Architecture:** The scorer is the graph's only WRITER; this PR adds the READ side to `@agora/api` (docs/SOCIAL-GRAPH.md §3). A Cypher query returns per-ordered-pair decayed warmth/friction sums `{actor, recipient, w, f}`; all formula math (brightness cap+floor, S_p, banding with hysteresis) is pure TypeScript so it unit-tests without Neo4j. The endpoint is double-gated: social_config (`graphEnabled && weatherEnabled` → 400 when off) then infrastructure (`NEO4J_URI` unset or query failure → 503). Results are cached in-process per project for 1 hour; trend comes from a dual-window computation (now vs. now−7d), no stored history. Decision log (user-confirmed): negative `sentiment` on Layer-1 INTERACTED edges feeds the friction term F now (full cap+floor formula live before PR 3's FRICTION edges); live compute + cache, no cron/table; members get `{value, band, trend}`. Per-space Weather is OUT of scope — `spaceId` is not written to Neo4j yet.

**Tech Stack:** Hono (ESM, `.js` import suffixes), Drizzle/Postgres (config only — no new tables), `neo4j-driver` (new dep, read-only), zod contract in `packages/contract`, React + TanStack Query in `apps/admin`, vitest unit + integration.

**The math (from docs/AGORA-SOCIAL.md §11, constants locked by design):**
- Per ordered pair (a→b): `W = Σ sentiment·decay(age, H_w)` over edges with `sentiment > 0`; `F = Σ (−sentiment)·decay(age, H_f)` over edges with `sentiment < 0`; `decay(age, H) = exp(−ln2 · ageDays / H)`.
- `S_w = W/(W+k_w)`, `φ = F/(F+W+k_w)`, `B = B_floor + (1−B_floor)·S_w·(1−c_f·φ)` with `k_w=10, c_f=0.5, B_floor=0.15`.
- `S_p(person)` = mean of inbound `B` over pairs targeting that person; **Weather = mean S_p** over all persons with ≥1 inbound pair. Empty graph → `null` / band `"quiet"`.
- Half-lives come from the project's resolved social_config (`warmthHalfLifeDays` default 30, `frictionHalfLifeDays` default 14).

**Branch:** `feat/social-weather` off `root`. Commit style: gitmoji conventional (`✨ feat(social): …`), trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Verification commands (run from repo root unless noted):**
- Contract build (ALWAYS after touching packages/contract, BEFORE typechecking dependents): `pnpm --filter @agora-server/contract build`
- Unit tests: `pnpm --filter @agora-server/contract test` and `cd apps/api && pnpm test`
- Typecheck: `pnpm -r typecheck`
- Integration: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration` (needs `TEST_DATABASE_URL` in `.env`; the TMPDIR override avoids macOS ENOSPC)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/contract/src/social.ts` | Modify (append) | `WEATHER_BANDS`, `WeatherBand`, `SocialWeather` response type |
| `packages/contract/src/social.test.ts` | Modify (append) | Band-constant drift guard |
| `apps/api/src/lib/env.ts` | Modify | `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` |
| `apps/api/src/lib/neo4j.ts` | Create | Lazy optional read-side driver (mirrors `lib/redis.ts`) |
| `apps/api/src/lib/social-weather.ts` | Create | Cypher constant, pure formula/band math, `computeWeather`, cached `getSocialWeather`, `invalidateSocialWeather` |
| `apps/api/src/lib/social-weather.test.ts` | Create | Unit tests: brightness, S_p aggregation, bands + hysteresis, trend/cache via stub driver |
| `apps/api/src/routes/social.ts` | Create | `GET /transparency` (moved from misc.ts, same public path) + `GET /weather` |
| `apps/api/src/routes/misc.ts` | Modify | Remove transparency route; invalidate weather cache on social PATCH |
| `apps/api/src/routes/index.ts` | Modify | Mount `project.route("/social", socialRoutes)` |
| `apps/api/vitest.integration.config.ts` | Modify | Force `NEO4J_URI: ""` (hermetic) |
| `apps/api/test/integration/social-weather.test.ts` | Create | Gate matrix: 401 / 400 disabled / 503 unconfigured / transparency regression |
| `apps/api/test/integration/social-weather-live.test.ts` | Create | Opt-in real-Neo4j math verification (`describe.runIf(TEST_NEO4J_URI)`) |
| `apps/api/package.json` | Modify | Add `neo4j-driver` |
| `.env.example` | Modify | Document NEO4J_* for the API read side |
| `apps/admin/src/lib/community.ts` | Modify | `SocialWeather` type + `getSocialWeather()` fetcher |
| `apps/admin/src/routes/CommunityPage.tsx` | Modify | Community Weather section |
| `CHANGELOG.md`, `docs/SOCIAL-GRAPH.md` | Modify | Unreleased entry; §3/§7 status notes |

---

### Task 1: Contract — Weather response type

**Files:**
- Modify: `packages/contract/src/social.ts` (append at end of file)
- Test: `packages/contract/src/social.test.ts` (append at end of file)

- [ ] **Step 1: Write the failing test**

Append to `packages/contract/src/social.test.ts`:

```typescript
describe("weather bands", () => {
  it("exposes the five bands, quiet first, no duplicates", () => {
    expect(WEATHER_BANDS).toEqual(["quiet", "stormy", "overcast", "fine", "sunny"]);
    expect(new Set(WEATHER_BANDS).size).toBe(WEATHER_BANDS.length);
  });
});
```

Add `WEATHER_BANDS` to the existing import from `"./social.js"` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agora-server/contract test`
Expected: FAIL — `WEATHER_BANDS` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/contract/src/social.ts`:

```typescript
// ── Community Weather (GET /v7/:projectId/social/weather) ───────────────────────────────────────
// One aggregate scalar — the only place friction shows publicly, as a dip in collective climate
// (docs/AGORA-SOCIAL.md §5). Safe to publish per the magnitude-regime theorem: friction big enough
// to move this number involves too many people to single anyone out.

export const WEATHER_BANDS = ["quiet", "stormy", "overcast", "fine", "sunny"] as const;
export type WeatherBand = (typeof WEATHER_BANDS)[number];

export interface SocialWeather {
  /** Mean S_p over the project, 0..1 rounded to 2dp; null when the graph has no interactions yet. */
  value: number | null;
  /** Bucketed label ("quiet" = no data). Band moves with hysteresis — see apps/api lib/social-weather. */
  band: WeatherBand;
  /** value(now) − value(as of 7 days ago), 3dp; null when either window has no data. */
  trend: number | null;
  /** ISO timestamp of computation (results are cached ~1h server-side). */
  asOf: string;
}
```

- [ ] **Step 4: Run test to verify it passes, then build the contract**

Run: `pnpm --filter @agora-server/contract test` → PASS
Run: `pnpm --filter @agora-server/contract build` → exits 0 (dependents typecheck against `dist/`).

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/social.ts packages/contract/src/social.test.ts
git commit -m "✨ feat(contract): SocialWeather response type + weather bands

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Env vars + optional Neo4j read client

No unit test for this task — it is config glue identical in shape to the untested `lib/redis.ts`; behavior is covered by Task 5's integration tests (503 when unset) and Task 6's live test (real driver).

**Files:**
- Modify: `apps/api/src/lib/env.ts` (after the `REDIS_URL` entry, ~line 52)
- Create: `apps/api/src/lib/neo4j.ts`
- Modify: `apps/api/vitest.integration.config.ts` (the `env:` block)
- Modify: `.env.example` (the existing Neo4j block, ~lines 178–181)
- Modify: `apps/api/package.json` (via pnpm)

- [ ] **Step 1: Install the driver**

Run: `cd apps/api && pnpm add neo4j-driver`
Expected: `neo4j-driver` appears in `apps/api/package.json` dependencies.

- [ ] **Step 2: Add env vars**

In `apps/api/src/lib/env.ts`, insert after the `REDIS_URL` line:

```typescript
  // Neo4j (DozerDB) — the social graph's READ side (docs/SOCIAL-GRAPH.md §3). The scorer service is
  // the graph's only writer; the API only runs read queries (Weather). Unset → social graph read
  // endpoints return 503 and the rest of the server is unaffected. e.g. bolt://neo4j:7687
  NEO4J_URI: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  NEO4J_USER: z.string().default("neo4j"),
  NEO4J_PASSWORD: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
```

- [ ] **Step 3: Create the lazy client**

Create `apps/api/src/lib/neo4j.ts`:

```typescript
// Optional Neo4j (DozerDB) driver — the social graph's READ side (docs/SOCIAL-GRAPH.md §3). The
// scorer service is the graph's only writer; the API never writes. Lazily constructed and fail-soft,
// mirroring lib/redis.ts: NEO4J_URI unset → null, and social read endpoints respond 503.
import neo4j, { type Driver } from "neo4j-driver";
import { env } from "./env.js";
import { logger } from "./logger.js";

let driver: Driver | null = null;
let attempted = false;

/** Whether the social-graph read side is configured at all (cheap, no connection). */
export function neo4jEnabled(): boolean {
  return !!env.NEO4J_URI;
}

/** The shared read-side driver, or null when NEO4J_URI is unset. Constructed once; the driver
 *  manages its own connection pool and reconnects, so a down Neo4j surfaces as query errors
 *  (handled per-request), never a crashed boot. */
export function getNeo4j(): Driver | null {
  if (attempted) return driver;
  attempted = true;
  if (!env.NEO4J_URI) return null;
  driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD ?? ""), {
    connectionAcquisitionTimeout: 5_000, // fail fast instead of hanging when Neo4j is down
  });
  logger.info("neo4j: social-graph read client enabled");
  return driver;
}
```

- [ ] **Step 4: Keep integration tests hermetic**

In `apps/api/vitest.integration.config.ts`, extend the `env:` block (after `ANTHROPIC_API_KEY: ""`):

```typescript
      // Hermetic for the same reason: a developer's .env may point NEO4J_URI at a live DozerDB.
      // Forced unset, the weather endpoint's 503 path is deterministic. The opt-in live test
      // (social-weather-live.test.ts) uses TEST_NEO4J_URI with its own driver instead.
      NEO4J_URI: "",
```

- [ ] **Step 5: Update `.env.example`**

Replace the existing Neo4j comment block (currently `# Neo4j relationship edges (FOUNDATION — graph schema out of scope). Unset → edge write is a no-op.`) with:

```bash
# Neo4j / DozerDB social graph. The scorer WRITES edges (unset → edge writes are no-ops); the API
# READS them for Garden surfaces like GET /social/weather (unset → those endpoints return 503).
# Both sides use the same three vars. See docs/SOCIAL-GRAPH.md.
# NEO4J_URI=bolt://neo4j:7687
# NEO4J_USER=neo4j
# NEO4J_PASSWORD=please_change_me
```

- [ ] **Step 6: Verify**

Run: `pnpm -r typecheck` → exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/env.ts apps/api/src/lib/neo4j.ts apps/api/vitest.integration.config.ts apps/api/package.json pnpm-lock.yaml .env.example
git commit -m "✨ feat(api): optional env-gated Neo4j read client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Weather math — pure functions (TDD)

**Files:**
- Create: `apps/api/src/lib/social-weather.ts` (pure part only; the driver-facing part is Task 4)
- Test: `apps/api/src/lib/social-weather.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/lib/social-weather.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  pairBrightness, weatherFromPairs, weatherBand,
  B_FLOOR, type WarmthPair,
} from "./social-weather.js";

// Formula (docs/AGORA-SOCIAL.md §11): S_w = W/(W+10); φ = F/(F+W+10);
// B = 0.15 + 0.85·S_w·(1−0.5·φ). All expected values below are hand-computed from that.

describe("pairBrightness", () => {
  it("zero warmth sits exactly at the floor", () => {
    expect(pairBrightness(0, 0)).toBeCloseTo(0.15, 10);
  });

  it("pure friction cannot dip below the floor (FLOOR guarantee)", () => {
    expect(pairBrightness(0, 100)).toBeCloseTo(0.15, 10);
  });

  it("computes warmth-only brightness: W=1 → 0.15 + 0.85·(1/11)", () => {
    expect(pairBrightness(1, 0)).toBeCloseTo(0.15 + 0.85 * (1 / 11), 10);
  });

  it("friction removes at most half the warmth term (CAP guarantee)", () => {
    // φ → 1 as F → ∞, so B → floor + warmthTerm·(1−0.5·1) = floor + warmthTerm/2.
    const warm = pairBrightness(100, 0) - B_FLOOR;
    const stormy = pairBrightness(100, 1e9) - B_FLOOR;
    expect(stormy).toBeGreaterThan(warm / 2 - 1e-6);
    expect(stormy).toBeLessThan(warm);
  });

  it("a saturated tie approaches but never exceeds 1", () => {
    const b = pairBrightness(1e9, 0);
    expect(b).toBeGreaterThan(0.99);
    expect(b).toBeLessThanOrEqual(1);
  });
});

describe("weatherFromPairs", () => {
  const pair = (actor: string, recipient: string, w: number, f = 0): WarmthPair => ({ actor, recipient, w, f });

  it("returns null on an empty graph", () => {
    expect(weatherFromPairs([])).toBeNull();
  });

  it("single inbound pair: weather = that pair's brightness", () => {
    expect(weatherFromPairs([pair("a", "b", 1)])).toBeCloseTo(pairBrightness(1, 0), 10);
  });

  it("S_p is the mean of INBOUND brightness per recipient, weather the mean of S_p", () => {
    // b receives from a (W=1) and c (W=3) → S_p(b) = mean(B(1,0), B(3,0)).
    // a receives from b (W=2)            → S_p(a) = B(2,0).
    const pairs = [pair("a", "b", 1), pair("c", "b", 3), pair("b", "a", 2)];
    const spB = (pairBrightness(1, 0) + pairBrightness(3, 0)) / 2;
    const spA = pairBrightness(2, 0);
    expect(weatherFromPairs(pairs)).toBeCloseTo((spA + spB) / 2, 10);
  });

  it("a dogpile on one person barely moves the aggregate (magnitude-regime sanity)", () => {
    // 20 warm dyads; then 8 pure-friction pairs hit one recipient.
    const calm: WarmthPair[] = [];
    for (let i = 0; i < 20; i++) calm.push(pair(`u${i}`, `v${i}`, 5));
    const calmW = weatherFromPairs(calm)!;
    const dogpiled = [...calm, ...Array.from({ length: 8 }, (_, i) => pair(`troll${i}`, "v0", 0, 10))];
    const stormW = weatherFromPairs(dogpiled)!;
    expect(calmW - stormW).toBeLessThan(0.05); // one target ≈ aggregate unmoved
    expect(stormW).toBeLessThanOrEqual(calmW);
  });
});

describe("weatherBand", () => {
  it("maps null to quiet", () => {
    expect(weatherBand(null)).toBe("quiet");
  });

  it("buckets at 0.35 / 0.55 / 0.75 with no previous band", () => {
    expect(weatherBand(0.1)).toBe("stormy");
    expect(weatherBand(0.35)).toBe("overcast");
    expect(weatherBand(0.54)).toBe("overcast");
    expect(weatherBand(0.55)).toBe("fine");
    expect(weatherBand(0.75)).toBe("sunny");
    expect(weatherBand(0.99)).toBe("sunny");
  });

  it("holds the previous band inside the hysteresis margin of a boundary", () => {
    expect(weatherBand(0.755, "fine")).toBe("fine");      // crossed up, but within 0.02
    expect(weatherBand(0.745, "sunny")).toBe("sunny");    // dipped below, but within 0.02
  });

  it("switches once the value clears the margin", () => {
    expect(weatherBand(0.78, "fine")).toBe("sunny");
    expect(weatherBand(0.72, "sunny")).toBe("fine");
  });

  it("jumps immediately when the move spans more than one band", () => {
    expect(weatherBand(0.2, "sunny")).toBe("stormy");
  });

  it("ignores a quiet previous band", () => {
    expect(weatherBand(0.755, "quiet")).toBe("sunny");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm test -- social-weather`
Expected: FAIL — module `./social-weather.js` not found.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/lib/social-weather.ts`:

```typescript
// Community Weather — the read side of the warmth math (docs/AGORA-SOCIAL.md §11, SOCIAL-GRAPH.md §3).
// Cypher returns raw per-ordered-pair decayed sums {actor, recipient, w, f}; everything formula-shaped
// (cap+floor brightness, S_p, banding with hysteresis) lives here as pure functions so it unit-tests
// without a graph. Decision log (PR 2): negative Layer-1 sentiment feeds the friction term F until
// PR 3's dedicated FRICTION edges land; per-space Weather is deferred (spaceId isn't in the graph yet).
import type { Driver } from "neo4j-driver";
import type { ResolvedSocialConfig, SocialWeather, WeatherBand } from "@agora-server/contract";
import { getNeo4j } from "./neo4j.js";

// Design constants — locked by docs/AGORA-SOCIAL.md §11; deliberately NOT in social_config.
export const K_W = 10;       // warmth saturation constant
export const C_F = 0.5;      // CAP: friction can remove at most half the warmth term
export const B_FLOOR = 0.15; // FLOOR: extra-dark-equals-friction is unreadable by construction

const LN2 = Math.LN2;
const DAY_MS = 86_400_000;
const HYSTERESIS_MARGIN = 0.02;       // band moves only on a margin-crossing change (§12)
const TREND_WINDOW_MS = 7 * DAY_MS;   // trend = now vs. as-of-7-days-ago
const WEATHER_TTL_MS = 3_600_000;     // recompute at most hourly per project

export interface WarmthPair {
  actor: string;
  recipient: string;
  w: number; // decayed positive-sentiment sum, ≥ 0
  f: number; // decayed negative-sentiment magnitude sum, ≥ 0
}

/** Dyadic brightness B(u,v) with the CAP + FLOOR guarantees. */
export function pairBrightness(w: number, f: number): number {
  const sw = w / (w + K_W);
  const phi = f / (f + w + K_W);
  return B_FLOOR + (1 - B_FLOOR) * sw * (1 - C_F * phi);
}

/** Weather = mean over persons of S_p, where S_p = mean INBOUND brightness. Null when no pairs. */
export function weatherFromPairs(pairs: WarmthPair[]): number | null {
  if (pairs.length === 0) return null;
  const inbound = new Map<string, { sum: number; n: number }>();
  for (const p of pairs) {
    const acc = inbound.get(p.recipient) ?? { sum: 0, n: 0 };
    acc.sum += pairBrightness(p.w, p.f);
    acc.n += 1;
    inbound.set(p.recipient, acc);
  }
  let total = 0;
  for (const acc of inbound.values()) total += acc.sum / acc.n;
  return total / inbound.size;
}

const BAND_BOUNDS = [0.35, 0.55, 0.75] as const;
const BAND_SCALE: readonly WeatherBand[] = ["stormy", "overcast", "fine", "sunny"];

/** Bucket a weather value, holding the previous band inside HYSTERESIS_MARGIN of a boundary so the
 *  published label only moves on a persistent, margin-crossing change (docs/AGORA-SOCIAL.md §12). */
export function weatherBand(value: number | null, prevBand?: WeatherBand): WeatherBand {
  if (value == null) return "quiet";
  let idx = BAND_BOUNDS.filter((b) => value >= b).length;
  if (prevBand && prevBand !== "quiet") {
    const prevIdx = BAND_SCALE.indexOf(prevBand);
    if (Math.abs(idx - prevIdx) === 1) {
      const boundary = BAND_BOUNDS[Math.min(idx, prevIdx)];
      if (Math.abs(value - boundary) < HYSTERESIS_MARGIN) idx = prevIdx;
    }
  }
  return BAND_SCALE[idx];
}
```

(The driver-facing half — `WEATHER_PAIRS_CYPHER`, `computeWeather`, `getSocialWeather`, `invalidateSocialWeather` — is Task 4; the `Driver`/`ResolvedSocialConfig`/`SocialWeather` imports above are used there. If the typechecker flags them as unused at this commit, prefix is fine to defer: add them in Task 4 instead.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm test -- social-weather`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/social-weather.ts apps/api/src/lib/social-weather.test.ts
git commit -m "✨ feat(api): warmth/brightness/banding math for Community Weather

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Weather query + cached dual-window computation (TDD)

**Files:**
- Modify: `apps/api/src/lib/social-weather.ts` (append)
- Test: `apps/api/src/lib/social-weather.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/lib/social-weather.test.ts` (extend the top import with the new symbols):

```typescript
import {
  computeWeather, getSocialWeather, invalidateSocialWeather, WEATHER_PAIRS_CYPHER,
} from "./social-weather.js";
import { SOCIAL_TIER_DEFAULTS } from "@agora-server/contract";

// A stub neo4j Driver: returns canned {actor, recipient, w, f} records and logs each call's params.
function stubDriver(rowsByCall: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  let i = 0;
  const driver = {
    executeQuery: async (cypher: string, params: Record<string, unknown>) => {
      calls.push({ cypher, params });
      const rows = rowsByCall[Math.min(i++, rowsByCall.length - 1)];
      return { records: rows.map((r) => ({ get: (k: string) => r[k] })) };
    },
  };
  return { driver: driver as never, calls };
}

const cfg = SOCIAL_TIER_DEFAULTS.community;

describe("computeWeather", () => {
  it("passes projectId, asOf, and the config half-lives to the query", async () => {
    const { driver, calls } = stubDriver([[]]);
    await computeWeather(driver, "proj-1", cfg, 1_000_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].cypher).toBe(WEATHER_PAIRS_CYPHER);
    expect(calls[0].params).toMatchObject({
      projectId: "proj-1", asOf: 1_000_000,
      warmthHalfLifeDays: 30, frictionHalfLifeDays: 14,
    });
  });

  it("aggregates returned pairs through weatherFromPairs, tolerating neo4j Integer-likes", async () => {
    const { driver } = stubDriver([[
      { actor: "a", recipient: "b", w: 1, f: 0 },
      { actor: "c", recipient: "b", w: { toNumber: () => 3 }, f: { toNumber: () => 0 } },
    ]]);
    const v = await computeWeather(driver, "p", cfg, 0);
    expect(v).toBeCloseTo((pairBrightness(1, 0) + pairBrightness(3, 0)) / 2, 10);
  });

  it("returns null when the graph has no matching edges", async () => {
    const { driver } = stubDriver([[]]);
    expect(await computeWeather(driver, "p", cfg, 0)).toBeNull();
  });
});

describe("getSocialWeather", () => {
  const NOW = 1_750_000_000_000;

  it("computes value, 7d trend, and band; rounds value to 2dp and trend to 3dp", async () => {
    const { driver, calls } = stubDriver([
      [{ actor: "a", recipient: "b", w: 1e9, f: 0 }], // now: ≈ 1.0 → sunny
      [{ actor: "a", recipient: "b", w: 10, f: 0 }],  // 7d ago: 0.575
    ]);
    invalidateSocialWeather("p1");
    const out = await getSocialWeather("p1", cfg, { driver, nowMs: NOW });
    expect(calls[0].params.asOf).toBe(NOW);
    expect(calls[1].params.asOf).toBe(NOW - 7 * 86_400_000);
    expect(out.value).toBeCloseTo(1.0, 2);
    expect(out.band).toBe("sunny");
    expect(out.trend).toBeCloseTo(1.0 - 0.575, 3);
    expect(out.asOf).toBe(new Date(NOW).toISOString());
  });

  it("null windows → quiet band, null trend", async () => {
    const { driver } = stubDriver([[]]);
    invalidateSocialWeather("p2");
    const out = await getSocialWeather("p2", cfg, { driver, nowMs: NOW });
    expect(out).toMatchObject({ value: null, band: "quiet", trend: null });
  });

  it("serves from cache within the TTL and recomputes after invalidation", async () => {
    const { driver, calls } = stubDriver([[{ actor: "a", recipient: "b", w: 5, f: 0 }]]);
    invalidateSocialWeather("p3");
    const first = await getSocialWeather("p3", cfg, { driver, nowMs: NOW });
    const second = await getSocialWeather("p3", cfg, { driver, nowMs: NOW + 60_000 });
    expect(second).toBe(first);            // same object — cache hit
    expect(calls).toHaveLength(2);         // 2 windows, once
    invalidateSocialWeather("p3");
    await getSocialWeather("p3", cfg, { driver, nowMs: NOW + 120_000 });
    expect(calls).toHaveLength(4);
  });

  it("applies hysteresis against the previously served band after the TTL lapses", async () => {
    const { driver } = stubDriver([
      [{ actor: "a", recipient: "b", w: 1e9, f: 0 }],   // call 1 now-window → sunny (≈1.0)
      [{ actor: "a", recipient: "b", w: 1e9, f: 0 }],   // call 1 prior-window
      [{ actor: "a", recipient: "b", w: 23.33, f: 0 }], // call 2 now-window → B≈0.745, inside margin of 0.75
      [{ actor: "a", recipient: "b", w: 23.33, f: 0 }], // call 2 prior-window
    ]);
    invalidateSocialWeather("p4");
    const first = await getSocialWeather("p4", cfg, { driver, nowMs: NOW });
    expect(first.band).toBe("sunny");
    const second = await getSocialWeather("p4", cfg, { driver, nowMs: NOW + WEATHER_TTL_AND_A_BIT });
    expect(second.value).toBeCloseTo(0.74, 2);
    expect(second.band).toBe("sunny"); // held by hysteresis, raw bucket would be "fine"
  });
});

const WEATHER_TTL_AND_A_BIT = 3_600_000 + 1;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm test -- social-weather`
Expected: Task 3's tests PASS; the new blocks FAIL — `computeWeather` etc. not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/lib/social-weather.ts` (ensure the Task-3 imports of `Driver`, `ResolvedSocialConfig`, `SocialWeather`, `getNeo4j` are present at the top):

```typescript
// Per-ordered-pair decayed sums over Layer-1 INTERACTED edges. Decay is READ-TIME (edges are never
// rewritten): each edge contributes sentiment · exp(−ln2 · ageDays / halfLife), positives into w
// (warmth half-life) and negatives into f (friction half-life). `at` is epoch-ms (scorer timestamp()).
export const WEATHER_PAIRS_CYPHER = `
MATCH (a:User)-[r:INTERACTED]->(b:User)
WHERE r.projectId = $projectId AND r.at <= $asOf AND a.id <> b.id AND r.sentiment IS NOT NULL
WITH a.id AS actor, b.id AS recipient,
     sum(CASE WHEN r.sentiment > 0
          THEN r.sentiment * exp(-${LN2} * (toFloat($asOf - r.at) / ${DAY_MS}.0) / toFloat($warmthHalfLifeDays))
          ELSE 0.0 END) AS w,
     sum(CASE WHEN r.sentiment < 0
          THEN -r.sentiment * exp(-${LN2} * (toFloat($asOf - r.at) / ${DAY_MS}.0) / toFloat($frictionHalfLifeDays))
          ELSE 0.0 END) AS f
RETURN actor, recipient, w, f`;

// neo4j-driver may hand back Integer objects for whole numbers; sums here are floats but stay defensive.
const toNum = (v: unknown): number =>
  typeof v === "number" ? v : ((v as { toNumber?: () => number })?.toNumber?.() ?? 0);

type HalfLives = Pick<ResolvedSocialConfig, "warmthHalfLifeDays" | "frictionHalfLifeDays">;

/** One window: raw (unrounded) weather as of `asOfMs`, or null when the graph is empty. */
export async function computeWeather(
  driver: Driver, projectId: string, cfg: HalfLives, asOfMs: number,
): Promise<number | null> {
  const { records } = await driver.executeQuery(WEATHER_PAIRS_CYPHER, {
    projectId,
    asOf: asOfMs,
    warmthHalfLifeDays: cfg.warmthHalfLifeDays,
    frictionHalfLifeDays: cfg.frictionHalfLifeDays,
  });
  const pairs: WarmthPair[] = records.map((r) => ({
    actor: String(r.get("actor")),
    recipient: String(r.get("recipient")),
    w: toNum(r.get("w")),
    f: toNum(r.get("f")),
  }));
  return weatherFromPairs(pairs);
}

// Stale entries are kept past the TTL on purpose: the previous band anchors hysteresis.
const weatherCache = new Map<string, { payload: SocialWeather; at: number }>();

/** The member-facing Weather payload, cached per project for WEATHER_TTL_MS. Trend is dual-window
 *  (now vs. now − 7d) so no history table is needed. Throws when Neo4j is unconfigured/unreachable —
 *  the route maps that to 503. `opts` exists for tests (stub driver, frozen clock). */
export async function getSocialWeather(
  projectId: string, cfg: HalfLives, opts: { driver?: Driver; nowMs?: number } = {},
): Promise<SocialWeather> {
  const now = opts.nowMs ?? Date.now();
  const hit = weatherCache.get(projectId);
  if (hit && now - hit.at < WEATHER_TTL_MS) return hit.payload;
  const driver = opts.driver ?? getNeo4j();
  if (!driver) throw new Error("neo4j read client is not configured");
  const [current, prior] = await Promise.all([
    computeWeather(driver, projectId, cfg, now),
    computeWeather(driver, projectId, cfg, now - TREND_WINDOW_MS),
  ]);
  const value = current == null ? null : Math.round(current * 100) / 100;
  const payload: SocialWeather = {
    value,
    band: weatherBand(value, hit?.payload.band),
    trend: current == null || prior == null ? null : Math.round((current - prior) * 1000) / 1000,
    asOf: new Date(now).toISOString(),
  };
  weatherCache.set(projectId, { payload, at: now });
  return payload;
}

/** Drop a project's cached Weather (call after an admin PATCHes /settings/social — half-life or
 *  enablement changes should be visible promptly, not an hour later). */
export function invalidateSocialWeather(projectId: string): void {
  weatherCache.delete(projectId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm test -- social-weather` → PASS.
Run: `pnpm -r typecheck` → exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/social-weather.ts apps/api/src/lib/social-weather.test.ts
git commit -m "✨ feat(api): dual-window cached Weather computation over Layer-1 edges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Route + mount + cache invalidation + integration tests

**Files:**
- Create: `apps/api/src/routes/social.ts`
- Modify: `apps/api/src/routes/index.ts` (mount before the misc `"/"` route)
- Modify: `apps/api/src/routes/misc.ts` (remove the transparency route; add weather-cache invalidation)
- Test: `apps/api/test/integration/social-weather.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/test/integration/social-weather.test.ts`:

```typescript
// GET /social/weather gate matrix — hermetic (vitest.integration.config.ts forces NEO4J_URI empty,
// so the infra gate deterministically 503s). Order under test: auth → config (400) → infra (503).
// The real-graph math is covered by social-weather-live.test.ts (opt-in) and the unit suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("social weather", () => {
  let projectId: string;
  let admin: { id: string; token: string };
  let member: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    admin = await createUser(projectId, "admin");
    member = await createUser(projectId, "visitor");
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("requires auth", async () => {
    const res = await api("GET", `${B}/social/weather`);
    expect(res.status).toBe(401);
  });

  it("503s with social/graph-unavailable when Neo4j is unconfigured (default config: enabled)", async () => {
    const res = await api("GET", `${B}/social/weather`, { token: member.token });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("social/graph-unavailable");
  });

  it("400s with social/weather-disabled when weatherEnabled is off — config gate beats infra gate", async () => {
    const patch = await api("PATCH", `${B}/settings/social`, { token: admin.token, body: { weatherEnabled: false } });
    expect(patch.status).toBe(200);
    const res = await api("GET", `${B}/social/weather`, { token: member.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/weather-disabled");
  });

  it("graphEnabled=false also disables weather, even with weatherEnabled back on", async () => {
    const patch = await api("PATCH", `${B}/settings/social`, {
      token: admin.token, body: { weatherEnabled: null, graphEnabled: false },
    });
    expect(patch.status).toBe(200);
    const res = await api("GET", `${B}/social/weather`, { token: member.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/weather-disabled");
  });

  it("transparency endpoint still serves at its original path after moving to routes/social.ts", async () => {
    const res = await api("GET", `${B}/social/transparency`, { token: member.token });
    expect(res.status).toBe(200);
    expect(res.body.garden.weather).toBe(true); // weatherEnabled override was cleared above
    expect(res.body.garden.graph).toBe(false);  // graphEnabled=false from the previous test
  });
});
```

- [ ] **Step 2: Run to verify the new file fails**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- social-weather`
NOTE: the file filter passes through to the full suite in this setup — that's fine; confirm the `social weather` describe block FAILS (weather route 404s) while existing suites pass.

- [ ] **Step 3: Create the route file**

Create `apps/api/src/routes/social.ts`:

```typescript
// Social-graph READ endpoints (docs/SOCIAL-GRAPH.md §3) — the scorer service is the graph's only
// writer; @agora/api is its read side. Weather is the first Garden surface: one aggregate scalar,
// safe to publish per the magnitude-regime theorem (docs/AGORA-SOCIAL.md §11).
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { Errors } from "../http/errors.js";
import { logger } from "../lib/logger.js";
import { getSocialConfig, transparencyView } from "../lib/social-config.js";
import { neo4jEnabled } from "../lib/neo4j.js";
import { getSocialWeather } from "../lib/social-weather.js";

export const socialRoutes = new Hono<{ Variables: Variables }>()
  // INVARIANT (docs/AGORA-CORP.md §4, invariant 5): the active tier + enabled analytics are
  // readable by every member — people always know which instrument their instance is. Auth
  // required (not public). Moved here from misc.ts in PR 2; the public path is unchanged.
  .get("/transparency", requireAuth, async (c) =>
    c.json(transparencyView(await getSocialConfig(c.var.projectId))))
  // Gate order matters: config off is a deliberate project choice (400, even with no graph
  // configured); missing/unreachable Neo4j is an operational state (503).
  .get("/weather", requireAuth, async (c) => {
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.graphEnabled || !cfg.weatherEnabled) {
      throw Errors.badRequest("social/weather-disabled", "Community Weather is not enabled for this project");
    }
    if (!neo4jEnabled()) {
      return c.json({ error: "Social graph not configured", code: "social/graph-unavailable" }, 503);
    }
    try {
      return c.json(await getSocialWeather(c.var.projectId, cfg));
    } catch (err) {
      logger.warn({ err: (err as Error).message, projectId: c.var.projectId }, "social: weather query failed");
      return c.json({ error: "Social graph unavailable", code: "social/graph-unavailable" }, 503);
    }
  });
```

- [ ] **Step 4: Mount it**

In `apps/api/src/routes/index.ts`, add the import alongside the others:

```typescript
import { socialRoutes } from "./social.js";
```

and mount it after the steward line, BEFORE the misc `"/"` catch-all:

```typescript
  project.route("/steward", stewardRoutes);
  project.route("/social", socialRoutes);   // graph read side: transparency + weather
  // oauth, projects, crypto, utils — small, grouped in misc
  project.route("/", miscRoutes);
```

- [ ] **Step 5: Clean up misc.ts**

In `apps/api/src/routes/misc.ts`:

1. Delete the entire `.get("/social/transparency", …)` handler (including its `// ── social transparency …` comment block — it now lives in routes/social.ts).
2. In the import from `"../lib/social-config.js"`, drop `transparencyView` AND any other symbol that becomes unreferenced in the file after the removal (`getSocialConfig` was only used by the transparency handler — check before keeping it; `noUnusedLocals` will fail typecheck otherwise). Keep `invalidateSocialConfig` and `socialConfigView`.
3. Add the weather-cache import:
```typescript
import { invalidateSocialWeather } from "../lib/social-weather.js";
```
4. In `.patch("/settings/social", …)`, directly after the existing `invalidateSocialConfig(c.var.projectId);` line, add:
```typescript
    invalidateSocialWeather(c.var.projectId); // half-life/enablement changes shouldn't wait out the 1h weather TTL
```

- [ ] **Step 6: Run the integration suite to verify it passes**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration`
Expected: full suite PASSES, including the new `social weather` block AND the pre-existing `social-config.test.ts` transparency tests (regression check for the move).
Run: `pnpm -r typecheck` → exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/social.ts apps/api/src/routes/index.ts apps/api/src/routes/misc.ts apps/api/test/integration/social-weather.test.ts
git commit -m "✨ feat(api): GET /social/weather — config-gated, env-gated Garden surface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Opt-in live-Neo4j verification test

Hermetic CI never touches a real graph, so the Cypher itself needs an opt-in harness: set `TEST_NEO4J_URI` (+ optional `TEST_NEO4J_USER`/`TEST_NEO4J_PASSWORD`) at a disposable DozerDB/Neo4j and this file seeds edges, runs `computeWeather`, and checks hand-computed values. Skipped (not failed) when unset.

**Files:**
- Test: `apps/api/test/integration/social-weather-live.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// OPT-IN live-graph test for WEATHER_PAIRS_CYPHER — the one thing unit tests can't cover.
// Run with: TEST_NEO4J_URI=bolt://localhost:7687 TEST_NEO4J_PASSWORD=… pnpm test:integration
// Uses its own driver (the app's NEO4J_URI is forced empty for hermeticity) and namespaces all
// nodes under a random projectId, DETACH DELETEing them afterwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";
import { computeWeather, pairBrightness } from "../../src/lib/social-weather.js";

const uri = process.env.TEST_NEO4J_URI;
const DAY_MS = 86_400_000;
const cfg = { warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 };

describe.runIf(!!uri)("weather cypher (live graph)", () => {
  let driver: Driver;
  const projectId = randomUUID();
  const u = [randomUUID(), randomUUID(), randomUUID()];
  const NOW = Date.now();

  async function seedEdge(actor: string, recipient: string, sentiment: number, ageDays: number) {
    await driver.executeQuery(
      `MERGE (a:User {id: $actor}) MERGE (b:User {id: $recipient})
       CREATE (a)-[:INTERACTED {sourceId: $sourceId, kind: "comment", sentiment: $sentiment,
                                projectId: $projectId, at: $at, createdAt: $at}]->(b)`,
      { actor, recipient, sentiment, projectId, sourceId: randomUUID(), at: NOW - ageDays * DAY_MS },
    );
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      uri!,
      neo4j.auth.basic(process.env.TEST_NEO4J_USER ?? "neo4j", process.env.TEST_NEO4J_PASSWORD ?? ""),
    );
    await seedEdge(u[0], u[1], 1.0, 0);   // fresh full-warmth comment
    await seedEdge(u[0], u[1], 1.0, 30);  // one warmth half-life old → contributes 0.5
    await seedEdge(u[2], u[1], -1.0, 0);  // fresh friction
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.executeQuery(`MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`, { ids: u });
    await driver.close();
  });

  it("matches the hand-computed read-time-decayed aggregate", async () => {
    // Pair u0→u1: W = 1.0 + 1.0·exp(−ln2·30/30) = 1.5, F = 0 → B(1.5, 0)
    // Pair u2→u1: W = 0, F = 1.0 → B(0, 1) = floor (0.15)
    // S_p(u1) = mean of the two inbound; only recipient → weather = S_p(u1).
    const expected = (pairBrightness(1.5, 0) + pairBrightness(0, 1)) / 2;
    const v = await computeWeather(driver, projectId, cfg, NOW);
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(expected, 3);
  });

  it("scopes strictly by projectId", async () => {
    expect(await computeWeather(driver, randomUUID(), cfg, NOW)).toBeNull();
  });

  it("the prior window excludes newer edges", async () => {
    // As of 7d ago: the two age-0 edges don't exist yet; only the (then 23d-old) warm edge does.
    const expected = pairBrightness(Math.exp((-Math.LN2 * 23) / 30), 0);
    const v = await computeWeather(driver, projectId, cfg, NOW - 7 * DAY_MS);
    expect(v!).toBeCloseTo(expected, 3);
  });
});
```

- [ ] **Step 2: Verify both modes**

Run (skip mode): `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration` → the new file reports skipped, suite green.
Run (live mode, ONLY if a local DozerDB is reachable — otherwise note it as not-run in the task report, that is acceptable):
`cd apps/api && TEST_NEO4J_URI=bolt://localhost:7687 TEST_NEO4J_USER=neo4j TEST_NEO4J_PASSWORD=<from .env> TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- social-weather-live` → live block PASSES.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/integration/social-weather-live.test.ts
git commit -m "✅ test(api): opt-in live-Neo4j verification of the weather Cypher

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Admin dashboard — Community Weather card

**Files:**
- Modify: `apps/admin/src/lib/community.ts`
- Modify: `apps/admin/src/routes/CommunityPage.tsx`

No automated UI tests exist in apps/admin (PR-1 precedent); correctness is `pnpm -r typecheck` + the existing conventions. Types are hand-copied from the contract per the established pattern in `lib/settings.ts`.

- [ ] **Step 1: Add the fetcher**

Append to `apps/admin/src/lib/community.ts`:

```typescript
// ── Community Weather (GET /social/weather) ─────────────────────────────────────────────────────
// Hand-copied from @agora-server/contract SocialWeather (PR-1 precedent in lib/settings.ts).
export type WeatherBand = "quiet" | "stormy" | "overcast" | "fine" | "sunny";

export interface SocialWeather {
  value: number | null;
  band: WeatherBand;
  trend: number | null;
  asOf: string;
}

export const socialWeatherKey = ["social-weather"] as const;

export function getSocialWeather(signal?: AbortSignal): Promise<SocialWeather> {
  return api<SocialWeather>("/social/weather", { signal });
}
```

- [ ] **Step 2: Add the section to CommunityPage**

In `apps/admin/src/routes/CommunityPage.tsx`:

1. Extend the `../lib/community` import:
```typescript
import {
  getCommunityOverview, communityOverviewKey, getSocialWeather, socialWeatherKey,
  type CommunityOverview, type CommunityLeader, type CommunitySeriesPoint, type SocialWeather, type WeatherBand,
} from "../lib/community";
```

2. In `CommunityBody`, render the new section immediately after the pulse-card `</div>` (before the `Growth` section):
```tsx
      <WeatherSection />
```

3. Add the component near `ModerationChart` (it intentionally lives INSIDE CommunityBody, so it only renders for operators with stats configured — known tradeoff, noted in the PR body):

```tsx
// ── Community Weather: the social graph's aggregate warmth (GET /social/weather). Disabled config
// surfaces as a 400 and an unconfigured graph as a 503 — both render as a quiet muted note rather
// than an error, since either is a legitimate deployment state. ──
const BAND_META: Record<WeatherBand, { emoji: string; label: string }> = {
  sunny: { emoji: "☀️", label: "Sunny" },
  fine: { emoji: "🌤️", label: "Fine" },
  overcast: { emoji: "☁️", label: "Overcast" },
  stormy: { emoji: "⛈️", label: "Stormy" },
  quiet: { emoji: "🌫️", label: "Quiet" },
};

function WeatherSection() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: socialWeatherKey,
    queryFn: ({ signal }) => getSocialWeather(signal),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (
    <Section title="Community Weather" hint="Aggregate warmth from the social graph — decayed, anonymous, k-safe by construction">
      <Card className="p-5">
        {isLoading ? (
          <p className="text-sm text-faint">Reading the sky…</p>
        ) : isError ? (
          <p className="text-sm text-muted">{(error as Error)?.message ?? "Weather unavailable"}</p>
        ) : (
          <WeatherReading w={data!} />
        )}
      </Card>
    </Section>
  );
}

function WeatherReading({ w }: { w: SocialWeather }) {
  const meta = BAND_META[w.band];
  return (
    <div className="flex items-center gap-4">
      <span className="text-4xl" role="img" aria-label={meta.label}>{meta.emoji}</span>
      <div>
        <p className="text-2xl font-semibold tracking-tight text-fg">
          {meta.label}
          {w.value != null ? <span className="ml-2 text-base font-normal text-muted">warmth {Math.round(w.value * 100)}%</span> : null}
        </p>
        <p className="mt-0.5 text-sm">
          {w.value == null ? (
            <span className="text-faint">No interactions in the graph yet.</span>
          ) : (
            <><TrendDelta n={w.trend} /> <span className="text-faint">vs last week · as of {fmtDateTime(w.asOf)}</span></>
          )}
        </p>
      </div>
    </div>
  );
}

function TrendDelta({ n }: { n: number | null }) {
  if (n == null) return <span className="text-faint">—</span>;
  const pts = Math.round(Math.abs(n) * 100);
  if (pts === 0) return <span className="text-faint">steady</span>;
  return n > 0
    ? <span className="text-success">▲ +{pts} pts</span>
    : <span className="text-danger">▼ −{pts} pts</span>;
}
```

- [ ] **Step 3: Verify**

Run: `pnpm -r typecheck` → exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/lib/community.ts apps/admin/src/routes/CommunityPage.tsx
git commit -m "✨ feat(admin): Community Weather card on the community dashboard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Docs, changelog, full verification

**Files:**
- Modify: `CHANGELOG.md` (Unreleased → Added)
- Modify: `docs/SOCIAL-GRAPH.md` (§3 endpoint table + §7 status)

- [ ] **Step 1: CHANGELOG entry**

Under `## [Unreleased]` → `### Added` (create the heading if absent, matching the file's existing style), add:

```markdown
- Community Weather (docs/SOCIAL-GRAPH.md §3): `GET /v7/:projectId/social/weather` returns the
  project's aggregate warmth `{value, band, trend, asOf}` computed live from Layer-1 `INTERACTED`
  edges with read-time decay (warmth + friction half-lives from social_config), cached per project
  for 1h. Gated by `graphEnabled && weatherEnabled` (400 when off) and by the new optional
  `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` env vars (503 when unconfigured). The member
  transparency endpoint moved to `routes/social.ts` (path unchanged). Admin: Community Weather
  card on the Community dashboard.
```

- [ ] **Step 2: SOCIAL-GRAPH.md status notes**

1. In §3's read-side endpoint table, on the `GET /social/weather` row, mark it shipped, e.g. change the row's endpoint cell to `` `GET /social/weather` ✅ (PR 2) `` — keep the rest of the row intact.
2. In §7 (build order), under the Weather phase item, append a status line:

```markdown
> **Status: ✅ implemented (PR 2).** Live Cypher over Layer-1 `INTERACTED` edges, dual-window trend
> (now vs. −7d), 1h per-project cache, band hysteresis (±0.02). Negative Layer-1 sentiment feeds the
> friction term until PR 3's dedicated FRICTION edges land. Per-space Weather deferred — `spaceId`
> is not yet written to the graph (scorer change, later PR).
```

(Adapt anchors to the actual headings — the implementer should read the file and place these where §3's table and §7's phase list actually are.)

- [ ] **Step 3: Full verification sweep**

```bash
pnpm --filter @agora-server/contract build
pnpm -r typecheck
pnpm --filter @agora-server/contract test
cd apps/api && pnpm test && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration
```
Expected: all green (live-Neo4j file skipped unless `TEST_NEO4J_URI` set).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/SOCIAL-GRAPH.md
git commit -m "📝 docs: changelog + SOCIAL-GRAPH status for Community Weather (PR 2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope (do NOT build in this PR)

- Per-space Weather / `?spaceId=` — `spaceId` is not written to Neo4j yet (scorer change, PR 3+).
- Layer-2 FRICTION / CO_PARTICIPATES edges — PR 3 (scorer).
- Cron-materialized weather snapshots/history table — the dual-window trend makes it unnecessary now; `/internal/cron/*` remains the escape hatch if live compute gets slow.
- Member/demo-app weather UI — admin card only this PR.
- Constellation, Neighborhood, OpenGDS analytics — later phases.
