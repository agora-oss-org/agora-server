import { describe, it, expect, beforeEach } from "vitest";
import { hit, sweep, _reset } from "./rate-limit.js";

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
