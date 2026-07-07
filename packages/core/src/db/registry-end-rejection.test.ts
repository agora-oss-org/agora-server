// Eviction must survive a rejecting client.end(): the pool is forgotten,
// nothing throws, no unhandled rejection. postgres is module-mocked; drizzle never queries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const endMock = vi.fn(() => Promise.reject(new Error("drain failed")));
vi.mock("postgres", () => ({
  default: vi.fn(() => ({ end: endMock, options: { parsers: {}, serializers: {} } })),
}));

import { env } from "../lib/env.js";
import { endAllPools, getDbForDsn } from "./registry.js";

const dsn = (n: number) => `postgres://u:p@host${n}.invalid:6432/agora`;

describe("registry × rejecting end()", () => {
  const savedMaxPools = env.MAX_POOLS;
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await endAllPools();
    vi.useRealTimers();
    (env as { MAX_POOLS: number }).MAX_POOLS = savedMaxPools;
  });

  it("eviction survives end() rejection and still forgets the pool", async () => {
    (env as { MAX_POOLS: number }).MAX_POOLS = 1;
    const a = getDbForDsn(dsn(1));
    vi.advanceTimersByTime(6 * 60 * 1000);
    getDbForDsn(dsn(2)); // evicts a; its end() rejects
    await vi.runAllTimersAsync(); // let the rejected drain settle (must not become unhandled)
    expect(endMock).toHaveBeenCalled();
    expect(getDbForDsn(dsn(1))).not.toBe(a); // evicted despite the failed drain
  });

  it("endAllPools resolves even when every end() rejects", async () => {
    getDbForDsn(dsn(3));
    getDbForDsn(dsn(4));
    await expect(endAllPools()).resolves.toBeUndefined();
  });
});
