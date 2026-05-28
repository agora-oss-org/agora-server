import { describe, it, expect } from "vitest";
import { asc, desc, sql } from "drizzle-orm";
import {
  RANKING_ALGORITHMS,
  KNOWN_ALGORITHMS,
  DEFAULT_RANK_PARAMS,
  DEFAULT_WEIGHTS,
  parseRankParams,
} from "./ranking.js";

const D = DEFAULT_RANK_PARAMS;

describe("parseRankParams", () => {
  it("returns the defaults for empty/missing input", () => {
    expect(parseRankParams(undefined, D)).toEqual(D);
    expect(parseRankParams(null, D)).toEqual(D);
    expect(parseRankParams("", D)).toEqual(D);
  });

  it("returns the defaults for malformed JSON", () => {
    expect(parseRankParams("{not json", D)).toEqual(D);
    expect(parseRankParams("undefined", D)).toEqual(D);
  });

  it("returns the defaults for non-object JSON (number/array/null)", () => {
    expect(parseRankParams("5", D)).toEqual(D);
    expect(parseRankParams("[1,2]", D)).toEqual(D);
    expect(parseRankParams("null", D)).toEqual(D);
  });

  it("merges a valid partial over the defaults", () => {
    expect(parseRankParams(JSON.stringify({ gravity: 2 }), D)).toEqual({ ...D, gravity: 2 });
    expect(parseRankParams(JSON.stringify({ halfLifeHours: 48, m: 0.9 }), D)).toEqual({
      ...D,
      halfLifeHours: 48,
      m: 0.9,
    });
  });

  it("rejects the WHOLE object when any field is out of range (→ defaults)", () => {
    expect(parseRankParams(JSON.stringify({ halfLifeHours: 0 }), D)).toEqual(D); // < 0.1
    expect(parseRankParams(JSON.stringify({ halfLifeHours: 99999 }), D)).toEqual(D); // > 8760
    expect(parseRankParams(JSON.stringify({ gravity: 10 }), D)).toEqual(D); // > 5
    expect(parseRankParams(JSON.stringify({ m: 2 }), D)).toEqual(D); // > 1
    expect(parseRankParams(JSON.stringify({ z: -1 }), D)).toEqual(D); // < 0
    // a valid field paired with an invalid one is still fully rejected
    expect(parseRankParams(JSON.stringify({ gravity: 2, m: 5 }), D)).toEqual(D);
  });

  it("accepts the range boundaries", () => {
    expect(
      parseRankParams(JSON.stringify({ halfLifeHours: 0.1, gravity: 5, z: 0, C: 0, m: 1 }), D),
    ).toEqual({ halfLifeHours: 0.1, gravity: 5, z: 0, C: 0, m: 1 });
  });

  it("rejects non-finite / wrong-typed values (→ defaults)", () => {
    expect(parseRankParams(JSON.stringify({ gravity: null }), D)).toEqual(D);
    expect(parseRankParams(JSON.stringify({ gravity: "2" }), D)).toEqual(D);
  });
});

describe("RANKING_ALGORITHMS registry", () => {
  const ctx = { params: DEFAULT_RANK_PARAMS, weights: DEFAULT_WEIGHTS, anchor: sql`now()`, dir: desc };

  it("exposes exactly the expected closed set of algorithms", () => {
    expect([...KNOWN_ALGORITHMS].sort()).toEqual([
      "bayesian",
      "controversial",
      "decay",
      "gravity",
      "hot",
      "new",
      "top",
      "wilson",
    ]);
  });

  it("only `hot` is index-served (stored); the rest are query-time", () => {
    expect(RANKING_ALGORITHMS.hot!.storage).toBe("stored");
    for (const name of KNOWN_ALGORITHMS.filter((n) => n !== "hot")) {
      expect(RANKING_ALGORITHMS[name]!.storage).toBe("query-time");
    }
  });

  it("every algorithm emits a non-empty ORDER BY list with deterministic tiebreakers", () => {
    for (const name of KNOWN_ALGORITHMS) {
      const order = RANKING_ALGORITHMS[name]!.order(ctx as any);
      expect(Array.isArray(order)).toBe(true);
      // primary sort expression + at least one tiebreaker (createdAt / id)
      expect(order.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("builds the same arity regardless of sort direction", () => {
    for (const name of KNOWN_ALGORITHMS) {
      const a = RANKING_ALGORITHMS[name]!.order({ ...ctx, dir: asc } as any);
      const d = RANKING_ALGORITHMS[name]!.order({ ...ctx, dir: desc } as any);
      expect(a.length).toBe(d.length);
    }
  });
});

describe("DEFAULT_WEIGHTS", () => {
  it("covers every reaction type with finite numeric weights", () => {
    for (const k of ["upvote", "downvote", "like", "love", "wow", "sad", "angry", "funny"]) {
      expect(typeof DEFAULT_WEIGHTS[k]).toBe("number");
      expect(Number.isFinite(DEFAULT_WEIGHTS[k])).toBe(true);
    }
  });
});
