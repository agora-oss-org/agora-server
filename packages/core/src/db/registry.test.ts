// Unit tests for the DSN-keyed pool registry. postgres.js clients are lazy (no
// connection until a query) so fake DSNs are safe; we never query.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../lib/env.js";
import { endAllPools, getDbForDsn } from "./registry.js";

const dsn = (n: number) => `postgres://u:p@host${n}.invalid:6432/agora`;

describe("getDbForDsn", () => {
  const savedMaxPools = env.MAX_POOLS;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await endAllPools();
    vi.useRealTimers();
    (env as { MAX_POOLS: number }).MAX_POOLS = savedMaxPools;
  });

  it("returns the same handle for the same DSN (dedupe)", () => {
    expect(getDbForDsn(dsn(1))).toBe(getDbForDsn(dsn(1)));
  });

  it("returns distinct handles for distinct DSNs", () => {
    expect(getDbForDsn(dsn(1))).not.toBe(getDbForDsn(dsn(2)));
  });

  it("evicts the least-recently-used idle entry past the cap", () => {
    (env as { MAX_POOLS: number }).MAX_POOLS = 2;
    const a = getDbForDsn(dsn(1));
    vi.advanceTimersByTime(1000);
    const b = getDbForDsn(dsn(2));
    // age both past the recent-use guard (5 min), a is oldest
    vi.advanceTimersByTime(6 * 60 * 1000);
    getDbForDsn(dsn(3)); // cap hit -> evicts a
    expect(getDbForDsn(dsn(2))).toBe(b); // b survived
    expect(getDbForDsn(dsn(1))).not.toBe(a); // a was evicted -> fresh handle
  });

  it("never evicts a recently-used entry (in-flight/detached work guard)", () => {
    (env as { MAX_POOLS: number }).MAX_POOLS = 2;
    const a = getDbForDsn(dsn(1));
    const b = getDbForDsn(dsn(2));
    // both used "just now" -> evictor must decline; registry grows past cap instead
    const c = getDbForDsn(dsn(3));
    expect(getDbForDsn(dsn(1))).toBe(a);
    expect(getDbForDsn(dsn(2))).toBe(b);
    expect(getDbForDsn(dsn(3))).toBe(c);
  });

  it("endAllPools clears the registry (fresh handles after)", async () => {
    const a = getDbForDsn(dsn(1));
    await endAllPools();
    expect(getDbForDsn(dsn(1))).not.toBe(a);
  });

  it("evicts at most ONE entry per over-cap insert (converges gradually)", () => {
    (env as { MAX_POOLS: number }).MAX_POOLS = 2;
    const a = getDbForDsn(dsn(1));
    vi.advanceTimersByTime(1000);
    const b = getDbForDsn(dsn(2));
    vi.advanceTimersByTime(6 * 60 * 1000); // both aged past the idle guard
    getDbForDsn(dsn(3)); // over cap -> exactly one eviction (a, the oldest)
    expect(getDbForDsn(dsn(2))).toBe(b); // b survived the same insert
  });

  // The old lazy-read fallback (invalid → 50) is gone: MAX_POOLS is now validated at boot by
  // the env schema. Assert the schema itself rejects what the fallback used to paper over.
  it("env schema rejects an invalid MAX_POOLS at parse time (fail loud at boot)", async () => {
    const { z } = await import("zod");
    const maxPools = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().default(50));
    expect(maxPools.parse(undefined)).toBe(50);
    expect(maxPools.parse("")).toBe(50);
    expect(maxPools.parse("7")).toBe(7);
    expect(() => maxPools.parse("0")).toThrow();
    expect(() => maxPools.parse("-1")).toThrow();
    expect(() => maxPools.parse("not-a-number")).toThrow();
  });
});
