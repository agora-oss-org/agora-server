// Fixed-window rate limiter for the API edge (consumed by middleware/rate-limit.ts). The default store
// is in-memory + per-process (behind N replicas the ceiling is ~N×max — fine for abuse mitigation, not
// exact quota); set REDIS_URL for a shared store that holds the cap across replicas. Windows reset
// lazily on hit and are swept periodically so the map can't grow unbounded as client keys churn. `now`
// is injectable so the behaviour is deterministic under test (no reliance on the wall clock).
import type Redis from "ioredis";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

interface Window {
  count: number;
  resetAt: number; // epoch ms when this window rolls over
}

const windows = new Map<string, Window>();

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

/** Record one hit against `key` and report whether it's within `max` per `windowMs`. */
export function hit(key: string, max: number, windowMs: number, now: number = Date.now()): RateResult {
  let w = windows.get(key);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: now + windowMs };
    windows.set(key, w);
  }
  w.count += 1;
  return {
    allowed: w.count <= max,
    limit: max,
    remaining: Math.max(0, max - w.count),
    retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
  };
}

/** Drop windows whose period has elapsed — bounds memory as client keys churn. */
export function sweep(now: number = Date.now()): void {
  for (const [key, w] of windows) if (now >= w.resetAt) windows.delete(key);
}

/** Clear all state (test helper). */
export function _reset(): void {
  windows.clear();
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic window sweep (idempotent). Call once at server startup. */
export function startRateLimitSweep(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => sweep(), intervalMs);
  timer.unref?.(); // don't keep the process alive just for the sweep
}

// ─── client-IP derivation (spoof-resistant) ────────────────────────────────────
/**
 * Real client IP for limiting. Trusted proxies append the peer to the RIGHT of X-Forwarded-For, so we
 * read `trustedHops` from the right — never the client-controlled left-most value. Falls back to
 * X-Real-IP, then "unknown", when XFF has fewer hops than expected (don't trust a short/forged chain).
 */
export function clientIp(xff: string | undefined, realIp: string | undefined, trustedHops: number): string {
  const hops = Math.max(1, Math.trunc(trustedHops) || 1);
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= hops) return parts[parts.length - hops]!;
  }
  return realIp?.trim() || "unknown";
}

// ─── pluggable store (in-memory default, optional Redis) ────────────────────────
export interface RateLimitStore {
  hit(key: string, max: number, windowMs: number): Promise<RateResult>;
}

const memoryStore: RateLimitStore = {
  hit: (key, max, windowMs) => Promise.resolve(hit(key, max, windowMs)),
};

// Atomic fixed-window: INCR the counter, set the TTL only when it's freshly created, and return both
// the count and the remaining TTL (ms) so a shared window resets cleanly across replicas.
const LUA_HIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return {c, tonumber(ARGV[1])}
end
return {c, redis.call('PTTL', KEYS[1])}`;

let redisFallbackLogged = false;

export function redisStore(client: Redis): RateLimitStore {
  return {
    async hit(key, max, windowMs) {
      try {
        const res = (await client.eval(LUA_HIT, 1, `rl:${key}`, String(windowMs))) as [number, number];
        const count = Number(res[0]);
        let ttl = Number(res[1]);
        if (!Number.isFinite(ttl) || ttl <= 0) ttl = windowMs;
        return {
          allowed: count <= max,
          limit: max,
          remaining: Math.max(0, max - count),
          retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)),
        };
      } catch (err) {
        if (!redisFallbackLogged) {
          redisFallbackLogged = true;
          logger.warn({ err: (err as Error).message }, "redis: rate-limit hit failed — falling back to in-memory");
        }
        return hit(key, max, windowMs); // fail-open: degrade to per-process, never 500 the request
      }
    },
  };
}

let store: RateLimitStore | null = null;

/** The active store: Redis when REDIS_URL is set, else in-memory. Resolved once. */
export function getStore(): RateLimitStore {
  if (store) return store;
  const client = getRedis();
  store = client ? redisStore(client) : memoryStore;
  return store;
}
