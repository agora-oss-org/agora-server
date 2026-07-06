// Unit tests for the DSN-keyed pool registry. postgres.js clients are lazy (no
// connection until a query) so fake DSNs are safe; we never query.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endAllPools, getDbForDsn } from "./registry.js";

const dsn = (n: number) => `postgres://u:p@host${n}.invalid:6432/agora`;

describe("getDbForDsn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await endAllPools();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns the same handle for the same DSN (dedupe)", () => {
    expect(getDbForDsn(dsn(1))).toBe(getDbForDsn(dsn(1)));
  });

  it("returns distinct handles for distinct DSNs", () => {
    expect(getDbForDsn(dsn(1))).not.toBe(getDbForDsn(dsn(2)));
  });

  it("evicts the least-recently-used idle entry past the cap", () => {
    vi.stubEnv("MAX_POOLS", "2");
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
    vi.stubEnv("MAX_POOLS", "2");
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
});
