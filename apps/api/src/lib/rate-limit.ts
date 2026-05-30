// In-memory fixed-window rate limiter for the API edge (consumed by middleware/rate-limit.ts).
// Per-process: each replica keeps its own windows, so behind N replicas the effective ceiling is
// ~N×max — fine for abuse mitigation, not exact quota. Windows reset lazily on hit and are swept
// periodically so the map can't grow unbounded as client keys churn. `now` is injectable so the
// behaviour is deterministic under test (no reliance on the wall clock).

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
