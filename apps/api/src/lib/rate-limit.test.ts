import { describe, it, expect, beforeEach } from "vitest";
import { hit, sweep, _reset, clientIp, redisStore } from "./rate-limit.js";
import type Redis from "ioredis";

describe("rate-limit", () => {
  beforeEach(() => _reset());

  it("allows hits up to max, then blocks within the window", () => {
    const t = 1_000;
    for (let i = 1; i <= 3; i++) {
      const r = hit("k", 3, 1000, t);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(3 - i);
    }
    const blocked = hit("k", 3, 1000, t);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBe(1);
  });

  it("resets once the window elapses", () => {
    expect(hit("k", 1, 1000, 0).allowed).toBe(true);
    expect(hit("k", 1, 1000, 500).allowed).toBe(false); // same window
    expect(hit("k", 1, 1000, 1000).allowed).toBe(true); // new window (now >= resetAt)
  });

  it("tracks keys independently", () => {
    expect(hit("a", 1, 1000, 0).allowed).toBe(true);
    expect(hit("a", 1, 1000, 0).allowed).toBe(false);
    expect(hit("b", 1, 1000, 0).allowed).toBe(true); // different key, own window
  });

  it("sweep drops only elapsed windows", () => {
    hit("old", 5, 1000, 0); // resetAt 1000
    hit("new", 5, 1000, 900); // resetAt 1900, count 1
    sweep(1000); // old elapsed → removed; new kept
    expect(hit("old", 5, 1000, 1000).remaining).toBe(4); // fresh window
    expect(hit("new", 5, 1000, 1000).remaining).toBe(3); // continues prior window (count 1 → 2)
  });
});

describe("clientIp", () => {
  it("ignores a spoofed left-most X-Forwarded-For (takes the trusted hop from the right)", () => {
    // attacker sends `X-Forwarded-For: 1.2.3.4`; the trusted edge appends the real peer on the right.
    expect(clientIp("1.2.3.4, 9.9.9.9", undefined, 1)).toBe("9.9.9.9");
  });

  it("reads the configured number of hops from the right", () => {
    expect(clientIp("1.1.1.1, 2.2.2.2, 3.3.3.3", undefined, 2)).toBe("2.2.2.2");
  });

  it("falls back to X-Real-IP when XFF has fewer hops than trusted", () => {
    expect(clientIp("only-one", "5.5.5.5", 2)).toBe("5.5.5.5");
  });

  it("falls back X-Forwarded-For → X-Real-IP → 'unknown'", () => {
    expect(clientIp(undefined, "5.5.5.5", 1)).toBe("5.5.5.5");
    expect(clientIp(undefined, undefined, 1)).toBe("unknown");
    expect(clientIp("", undefined, 1)).toBe("unknown");
  });
});

describe("redisStore", () => {
  const mock = (impl: (...a: unknown[]) => Promise<unknown>) => ({ eval: impl }) as unknown as Redis;

  it("maps the Lua [count, pttl] reply to a RateResult", async () => {
    const s = redisStore(mock(async () => [1, 60_000]));
    const r = await s.hit("gen:x", 5, 60_000);
    expect(r).toEqual({ allowed: true, limit: 5, remaining: 4, retryAfterSec: 60 });
  });

  it("blocks once the shared count exceeds max", async () => {
    const s = redisStore(mock(async () => [6, 2_000]));
    const r = await s.hit("gen:x", 5, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterSec).toBe(2);
  });

  it("uses the window as the retry floor when pttl is non-positive", async () => {
    const s = redisStore(mock(async () => [3, -1]));
    expect((await s.hit("gen:x", 5, 5_000)).retryAfterSec).toBe(5);
  });

  it("fails open to the in-memory limiter when Redis errors", async () => {
    const s = redisStore(mock(async () => { throw new Error("redis down"); }));
    expect((await s.hit("k", 1, 1000)).allowed).toBe(true);  // memory window, 1st hit
    expect((await s.hit("k", 1, 1000)).allowed).toBe(false); // memory window, 2nd hit > max
  });
});
