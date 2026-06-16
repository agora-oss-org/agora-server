import { describe, expect, it } from "vitest";
import { churnFromSeries, dominantSpaces, topByScore } from "./social-analytics.js";

describe("topByScore", () => {
  it("returns the highest-scored entries first, capped at n", () => {
    const scores = new Map([["a", 0.1], ["b", 0.9], ["c", 0.5], ["d", 0.7]]);
    expect(topByScore(scores, 2)).toEqual([
      { userId: "b", score: 0.9 },
      { userId: "d", score: 0.7 },
    ]);
  });

  it("returns everything when n exceeds the map size", () => {
    expect(topByScore(new Map([["a", 1]]), 10)).toEqual([{ userId: "a", score: 1 }]);
  });

  it("is empty for an empty map", () => {
    expect(topByScore(new Map(), 5)).toEqual([]);
  });
});

describe("dominantSpaces", () => {
  it("counts members per space, most-represented first, capped", () => {
    const memberSpaces = new Map([
      ["u1", ["s1", "s2"]],
      ["u2", ["s1"]],
      ["u3", ["s1", "s3"]],
    ]);
    expect(dominantSpaces(["u1", "u2", "u3"], memberSpaces, 2)).toEqual([
      { spaceId: "s1", memberCount: 3 },
      { spaceId: "s2", memberCount: 1 },
    ]);
  });

  it("ignores members with no spaces and is empty when none map", () => {
    expect(dominantSpaces(["x", "y"], new Map())).toEqual([]);
  });
});

describe("churnFromSeries", () => {
  it("flags a steep decline as at-risk (>25% drop)", () => {
    expect(churnFromSeries([0.8, 0.7, 0.5])).toEqual({ delta: -0.3, churnRisk: "at-risk" });
  });

  it("flags a moderate decline as watch (>10%, ≤25%)", () => {
    expect(churnFromSeries([1.0, 0.85])).toEqual({ delta: -0.15, churnRisk: "watch" });
  });

  it("is none for a shallow decline (≤10%)", () => {
    expect(churnFromSeries([1.0, 0.95])).toEqual({ delta: -0.05, churnRisk: "none" });
  });

  it("is none (with positive delta) when warmth is rising", () => {
    expect(churnFromSeries([0.5, 0.8])).toEqual({ delta: 0.3, churnRisk: "none" });
  });

  it("is none with zero delta for a single point", () => {
    expect(churnFromSeries([0.5])).toEqual({ delta: 0, churnRisk: "none" });
  });

  it("is none for an empty series", () => {
    expect(churnFromSeries([])).toEqual({ delta: 0, churnRisk: "none" });
  });

  it("does not divide by a zero baseline", () => {
    expect(churnFromSeries([0, 0.4])).toEqual({ delta: 0.4, churnRisk: "none" });
  });

  it("uses first vs last across a longer window (ignores intermediate dips)", () => {
    // baseline 1.0 → current 0.6 = 40% drop → at-risk, regardless of the bump in the middle
    expect(churnFromSeries([1.0, 0.4, 0.9, 0.6])).toEqual({ delta: -0.4, churnRisk: "at-risk" });
  });
});
