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
