// Unit tests for the Redis suspension index — the security-critical bits: FAIL-CLOSED reads (a Redis
// error must throw 503, never silently allow), best-effort write-through, and the ATOMIC rebuild
// (temp key + RENAME, with the empty-set → DEL special case). The ioredis client is mocked, so nothing
// connects; REDIS_URL is set in vitest.config.ts so the index is enabled.
import { describe, it, expect, vi, beforeEach } from "vitest";

// A chainable multi() recorder so we can assert the exact command sequence.
function makeMulti() {
  const ops: unknown[][] = [];
  const chain = {
    del: vi.fn((...a: unknown[]) => { ops.push(["del", ...a]); return chain; }),
    sadd: vi.fn((...a: unknown[]) => { ops.push(["sadd", ...a]); return chain; }),
    rename: vi.fn((...a: unknown[]) => { ops.push(["rename", ...a]); return chain; }),
    exec: vi.fn(async () => { ops.push(["exec"]); return []; }),
    ops,
  };
  return chain;
}

const fakeRedis = {
  sismember: vi.fn(),
  sadd: vi.fn(async () => 1),
  srem: vi.fn(async () => 1),
  del: vi.fn(async () => 1),
  lastMulti: makeMulti(),
  multi: vi.fn(function (this: typeof fakeRedis) {
    const m = makeMulti();
    fakeRedis.lastMulti = m;
    return m;
  }),
};

vi.mock("./redis.js", () => ({ getRedis: () => fakeRedis }));

const {
  isSuspendedRedis, addSuspended, removeSuspended, rebuildSuspendedSet, suspensionIndexEnabled,
} = await import("./suspension-index.js");
const { ApiError } = await import("../http/errors.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("suspension index", () => {
  it("is enabled when REDIS_URL is set", () => {
    expect(suspensionIndexEnabled()).toBe(true);
  });

  it("isSuspendedRedis returns true/false from SISMEMBER", async () => {
    fakeRedis.sismember.mockResolvedValueOnce(1);
    expect(await isSuspendedRedis("p1")).toBe(true);
    fakeRedis.sismember.mockResolvedValueOnce(0);
    expect(await isSuspendedRedis("p1")).toBe(false);
    expect(fakeRedis.sismember).toHaveBeenCalledWith("suspended:profiles", "p1");
  });

  it("FAILS CLOSED: a Redis error throws 503, never resolves false", async () => {
    fakeRedis.sismember.mockRejectedValue(new Error("redis down"));
    const err = await isSuspendedRedis("p1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
  });

  it("write-through: add → SADD, remove → SREM", async () => {
    await addSuspended("p9");
    expect(fakeRedis.sadd).toHaveBeenCalledWith("suspended:profiles", "p9");
    await removeSuspended("p9");
    expect(fakeRedis.srem).toHaveBeenCalledWith("suspended:profiles", "p9");
  });

  it("write-through is best-effort: a Redis error is swallowed (cron/boot are the backstops)", async () => {
    fakeRedis.sadd.mockRejectedValueOnce(new Error("redis down"));
    await expect(addSuspended("p9")).resolves.toBeUndefined();
  });

  it("rebuild with members: atomic DEL tmp → SADD tmp → RENAME tmp→key → EXEC", async () => {
    await rebuildSuspendedSet(["a", "b", "c"]);
    expect(fakeRedis.multi).toHaveBeenCalledOnce();
    expect(fakeRedis.lastMulti.ops).toEqual([
      ["del", "suspended:profiles:rebuild"],
      ["sadd", "suspended:profiles:rebuild", "a", "b", "c"],
      ["rename", "suspended:profiles:rebuild", "suspended:profiles"],
      ["exec"],
    ]);
  });

  it("rebuild with NO members: just DEL the key (an empty Redis SET is a missing key)", async () => {
    await rebuildSuspendedSet([]);
    expect(fakeRedis.del).toHaveBeenCalledWith("suspended:profiles");
    expect(fakeRedis.multi).not.toHaveBeenCalled();
  });
});
