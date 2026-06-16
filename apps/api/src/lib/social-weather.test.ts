import { describe, expect, it } from "vitest";
import {
  pairBrightness, weatherFromPairs, weatherBand, mergePairRows,
  B_FLOOR, AGE_CUTOFF_HALF_LIVES, type WarmthPair,
  computeWeather, getSocialWeather, invalidateSocialWeather, WEATHER_PAIRS_CYPHER,
} from "./social-weather.js";
import { SOCIAL_TIER_DEFAULTS } from "@agora-server/contract";

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

describe("mergePairRows (additive fold of the UNION ALL branches)", () => {
  const pair = (actor: string, recipient: string, w: number, f = 0): WarmthPair => ({ actor, recipient, w, f });

  it("passes distinct directed pairs through unchanged", () => {
    expect(mergePairRows([pair("a", "b", 1), pair("c", "b", 3)])).toHaveLength(2);
  });

  it("keeps a→b and b→a separate (direction matters)", () => {
    expect(mergePairRows([pair("a", "b", 1), pair("b", "a", 1)])).toHaveLength(2);
  });

  it("sums w and f for the same directed pair (INTERACTED warmth + FRICTION report)", () => {
    const merged = mergePairRows([pair("a", "b", 5, 0), pair("a", "b", 0, 3)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ actor: "a", recipient: "b", w: 5, f: 3 });
  });

  it("friction DIMS the warm tie, it does not crash it into a separate floor-dark datapoint", () => {
    // Correct (merged): one tie B(5,3). Wrong (unmerged): two inbound pairs B(5,0) and B(0,3)=floor,
    // whose mean drags the recipient toward the floor. Merged must read as the single dimmed tie.
    const rows = [pair("a", "b", 5, 0), pair("a", "b", 0, 3)];
    const merged = weatherFromPairs(mergePairRows(rows))!;
    const unmerged = weatherFromPairs(rows)!;
    expect(merged).toBeCloseTo(pairBrightness(5, 3), 10);
    expect(merged).toBeLessThan(pairBrightness(5, 0)); // friction dimmed it...
    expect(merged).toBeGreaterThan(unmerged);          // ...but far less than the wrong split reading
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

  it("the margin is exclusive: exactly at boundary+0.02 switches, a hair inside holds", () => {
    expect(weatherBand(0.77, "fine")).toBe("sunny");  // |0.77 − 0.75| = margin → not held
    expect(weatherBand(0.769, "fine")).toBe("fine");  // one hair inside → still held
  });

  it("jumps immediately when the move spans more than one band", () => {
    expect(weatherBand(0.2, "sunny")).toBe("stormy");
  });

  it("ignores a quiet previous band", () => {
    expect(weatherBand(0.755, "quiet")).toBe("sunny");
  });
});

// A stub neo4j Driver: returns canned {actor, recipient, w, f} records and logs each call's params.
function stubDriver(rowsByCall: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  let i = 0;
  const driver = {
    executeQuery: async (cypher: string, params: Record<string, unknown>) => {
      calls.push({ cypher, params });
      const rows = rowsByCall[Math.min(i++, rowsByCall.length - 1)]!;
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
    expect(calls[0]!.cypher).toBe(WEATHER_PAIRS_CYPHER);
    expect(calls[0]!.params).toMatchObject({
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

  it("passes an age cutoff of asOf − AGE_CUTOFF_HALF_LIVES·warmthHalfLife days", async () => {
    const { driver, calls } = stubDriver([[]]);
    const asOf = 1_700_000_000_000;
    await computeWeather(driver, "p", cfg, asOf);
    expect(calls[0]!.params).toMatchObject({
      asOf,
      ageCutoff: asOf - AGE_CUTOFF_HALF_LIVES * cfg.warmthHalfLifeDays * 86_400_000,
    });
  });

  it("merges a pair emitted by BOTH UNION branches before computing brightness (additive)", async () => {
    // The Cypher's INTERACTED branch returns the warm row; the FRICTION branch returns the report row;
    // both for a→b. computeWeather must sum them into one dimmed tie, not two datapoints.
    const { driver } = stubDriver([[
      { actor: "a", recipient: "b", w: 5, f: 0 },
      { actor: "a", recipient: "b", w: 0, f: 3 },
    ]]);
    expect(await computeWeather(driver, "p", cfg, 0)).toBeCloseTo(pairBrightness(5, 3), 10);
  });
});

describe("getSocialWeather", () => {
  const NOW = 1_750_000_000_000;
  const WEATHER_TTL_AND_A_BIT = 3_600_000 + 1;

  it("computes value, 7d trend, and band; rounds value to 2dp and trend to 3dp", async () => {
    const { driver, calls } = stubDriver([
      [{ actor: "a", recipient: "b", w: 1e9, f: 0 }], // now: ≈ 1.0 → sunny
      [{ actor: "a", recipient: "b", w: 10, f: 0 }],  // 7d ago: 0.575
    ]);
    invalidateSocialWeather("p1");
    const out = await getSocialWeather("p1", cfg, { driver, nowMs: NOW });
    expect(calls[0]!.params.asOf).toBe(NOW);
    expect(calls[1]!.params.asOf).toBe(NOW - 7 * 86_400_000);
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

  it("propagates driver errors without caching, preserving the stale hysteresis anchor", async () => {
    const good = stubDriver([[{ actor: "a", recipient: "b", w: 1e9, f: 0 }]]);
    invalidateSocialWeather("p5");
    const first = await getSocialWeather("p5", cfg, { driver: good.driver, nowMs: NOW });
    expect(first.band).toBe("sunny");
    const bad = { executeQuery: async () => { throw new Error("bolt down"); } } as never;
    await expect(
      getSocialWeather("p5", cfg, { driver: bad, nowMs: NOW + WEATHER_TTL_AND_A_BIT }),
    ).rejects.toThrow("bolt down");
    // Recovery after the outage: the pre-outage entry survived and still anchors hysteresis.
    const recovered = stubDriver([[{ actor: "a", recipient: "b", w: 23.33, f: 0 }]]);
    const out = await getSocialWeather("p5", cfg, { driver: recovered.driver, nowMs: NOW + WEATHER_TTL_AND_A_BIT + 1 });
    expect(out.value).toBeCloseTo(0.74, 2);
    expect(out.band).toBe("sunny"); // raw bucket would be "fine" — held by the surviving anchor
  });

  it("returns frozen payloads so a handler can't poison the cache", async () => {
    const { driver } = stubDriver([[{ actor: "a", recipient: "b", w: 5, f: 0 }]]);
    invalidateSocialWeather("p6");
    const out = await getSocialWeather("p6", cfg, { driver, nowMs: NOW });
    expect(Object.isFrozen(out)).toBe(true);
  });
});
