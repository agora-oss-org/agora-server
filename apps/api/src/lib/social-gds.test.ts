import { describe, expect, it } from "vitest";
import { toNum, scoresFromRecords } from "./social-gds.js";

// A minimal stand-in for a neo4j-driver Record: `.get(key)` returns the pre-seeded field.
const rec = (fields: Record<string, unknown>) => ({ get: (k: string) => fields[k] });
// A minimal stand-in for a neo4j Integer (the driver wraps 64-bit ints as `{ toNumber() }`).
const int = (n: number) => ({ toNumber: () => n });

describe("toNum — neo4j numeric coercion", () => {
  it("passes a plain JS number through unchanged (incl. zero and negatives)", () => {
    expect(toNum(0)).toBe(0);
    expect(toNum(42)).toBe(42);
    expect(toNum(-7)).toBe(-7);
    expect(toNum(3.5)).toBe(3.5);
  });

  it("unwraps a neo4j Integer-like via toNumber()", () => {
    expect(toNum(int(100))).toBe(100);
    expect(toNum(int(0))).toBe(0);
  });

  it("falls back to 0 for anything without a numeric identity", () => {
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
    expect(toNum("5")).toBe(0); // a string is not a number and has no toNumber()
    expect(toNum({})).toBe(0); // plain object → toNumber is undefined → short-circuits to 0
  });
});

describe("scoresFromRecords — records → Map<userId, score>", () => {
  it("builds a map keyed by stringified userId with coerced scores", () => {
    const m = scoresFromRecords([
      rec({ userId: "u1", score: 0.9 }),
      rec({ userId: "u2", score: int(3) }),
    ]);
    expect(m.get("u1")).toBe(0.9);
    expect(m.get("u2")).toBe(3);
    expect(m.size).toBe(2);
  });

  it("stringifies non-string userIds and defaults unusable scores to 0", () => {
    const m = scoresFromRecords([
      rec({ userId: 7, score: null }),
      rec({ userId: "u3", score: undefined }),
    ]);
    expect(m.get("7")).toBe(0);
    expect(m.get("u3")).toBe(0);
  });

  it("returns an empty map for no records", () => {
    expect(scoresFromRecords([]).size).toBe(0);
  });

  it("last write wins on a duplicate userId", () => {
    const m = scoresFromRecords([
      rec({ userId: "dup", score: 1 }),
      rec({ userId: "dup", score: 2 }),
    ]);
    expect(m.get("dup")).toBe(2);
    expect(m.size).toBe(1);
  });
});
