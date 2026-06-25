// Outbound abuse throttle for Voyage embedding calls. A per-(stream, project) sliding-window rate meter
// feeding a 2-state circuit breaker with hysteresis — the protection against a runaway client/script
// blowing through Voyage's limits or our bill overnight. Mirrors lib/rate-limit.ts conventions:
// per-process + in-memory, `now` injectable for deterministic tests, idle entries swept so the map
// stays bounded. `rate` is "attempts in the window / windowSeconds" (average req/sec). Demand is counted
// even while tripped, so the breaker can see the surge subside and reopen.
//
// State machine per breaker (config from env, off until that stream's SPIKE_RATE is set):
//   closed: rate < spikeRate  → serve   (rate >= rateMax logs a one-shot "elevated" warning)
//           rate >= spikeRate → trip OPEN, deny
//   open:   rate <= resumeRate sustained for resumeMs → close, serve
//           rate >  resumeRate → reset the cooldown, deny
import { env } from "./env.js";
import { logger } from "./logger.js";

export type EmbedStream = "write" | "search";
export type BreakerStatus = "closed" | "open" | "disabled";

export interface StreamConfig {
  windowSeconds: number; // measurement window for the rate average
  spikeRate: number;     // Y — trip threshold (req/sec)
  rateMax: number;       // X — elevated/warn threshold (req/sec)
  resumeRate: number;    // Z — "normal level" the rate must fall back to (req/sec)
  resumeMs: number;      // Z1 — how long rate must stay <= resumeRate before resuming
}

interface Breaker {
  buckets: Map<number, number>; // second-index → attempt count, pruned to the window
  open: boolean;
  calmSince: number | null;     // ms when rate first fell <= resumeRate while open (cooldown anchor)
  elevatedWarned: boolean;      // one-shot guard so the "elevated" warn doesn't spam
  lastSeen: number;             // for idle eviction
}

/**
 * Effective config for one stream from raw env-ish inputs. Returns null (= disabled) when spikeRate is
 * unset. When rateMax / resumeRate are unset they default to fractions of spikeRate (the "calculated
 * normal level"); both are clamped to <= spikeRate so a misconfig can't make the breaker un-resumable.
 */
export function resolveStreamConfig(raw: {
  windowSeconds: number;
  spikeRate?: number;
  rateMax?: number;
  resumeRate?: number;
  resumeMs: number;
}): StreamConfig | null {
  if (!raw.spikeRate || raw.spikeRate <= 0) return null;
  const spikeRate = raw.spikeRate;
  const rateMax = Math.min(spikeRate, raw.rateMax ?? spikeRate * 0.6);
  const resumeRate = Math.min(spikeRate, raw.resumeRate ?? spikeRate * 0.4);
  return { windowSeconds: Math.max(1, raw.windowSeconds), spikeRate, rateMax, resumeRate, resumeMs: raw.resumeMs };
}

function loadConfig(): Record<EmbedStream, StreamConfig | null> {
  const windowSeconds = env.EMBED_THROTTLE_WINDOW_SECONDS;
  return {
    write: resolveStreamConfig({
      windowSeconds,
      spikeRate: env.EMBED_THROTTLE_WRITE_SPIKE_RATE,
      rateMax: env.EMBED_THROTTLE_WRITE_RATE_MAX,
      resumeRate: env.EMBED_THROTTLE_WRITE_RESUME_RATE,
      resumeMs: env.EMBED_THROTTLE_WRITE_RESUME_MS,
    }),
    search: resolveStreamConfig({
      windowSeconds,
      spikeRate: env.EMBED_THROTTLE_SEARCH_SPIKE_RATE,
      rateMax: env.EMBED_THROTTLE_SEARCH_RATE_MAX,
      resumeRate: env.EMBED_THROTTLE_SEARCH_RESUME_RATE,
      resumeMs: env.EMBED_THROTTLE_SEARCH_RESUME_MS,
    }),
  };
}

let config = loadConfig();
const breakers = new Map<string, Breaker>(); // key = `${stream}:${projectId}`

function rate(b: Breaker, nowSec: number, windowSeconds: number): number {
  const floor = nowSec - windowSeconds + 1;
  let sum = 0;
  for (const [sec, count] of b.buckets) {
    if (sec < floor) b.buckets.delete(sec);
    else sum += count;
  }
  return sum / windowSeconds;
}

/**
 * Record one embed attempt for (stream, project) and report whether it may proceed. A disabled stream
 * (no SPIKE_RATE) always returns true. Callers enqueue (write) or 429 (search) when this returns false.
 */
export function allow(stream: EmbedStream, projectId: string, now: number = Date.now()): boolean {
  const cfg = config[stream];
  if (!cfg) return true;

  const key = `${stream}:${projectId}`;
  let b = breakers.get(key);
  if (!b) {
    b = { buckets: new Map(), open: false, calmSince: null, elevatedWarned: false, lastSeen: now };
    breakers.set(key, b);
  }
  b.lastSeen = now;

  const nowSec = Math.floor(now / 1000);
  b.buckets.set(nowSec, (b.buckets.get(nowSec) ?? 0) + 1);
  const r = rate(b, nowSec, cfg.windowSeconds);

  if (!b.open) {
    if (r >= cfg.spikeRate) {
      b.open = true;
      b.calmSince = null;
      b.elevatedWarned = false;
      logger.warn({ stream, projectId, rate: Math.round(r) }, "embed-throttle: tripped — pausing embeds (spike)");
      return false;
    }
    if (r >= cfg.rateMax && !b.elevatedWarned) {
      b.elevatedWarned = true;
      logger.warn({ stream, projectId, rate: Math.round(r) }, "embed-throttle: elevated embed rate");
    } else if (r < cfg.rateMax) {
      b.elevatedWarned = false;
    }
    return true;
  }

  // open: watch demand subside back to the normal level for a sustained window
  if (r <= cfg.resumeRate) {
    if (b.calmSince === null) b.calmSince = now;
    if (now - b.calmSince >= cfg.resumeMs) {
      b.open = false;
      b.calmSince = null;
      b.elevatedWarned = false;
      logger.info("embed-throttle: resumed — embed rate back to normal");
      return true;
    }
  } else {
    b.calmSince = null; // re-spiked; restart the cooldown
  }
  return false;
}

/** Current breaker status for (stream, project) — for observability and tests. */
export function getBreakerState(stream: EmbedStream, projectId: string): BreakerStatus {
  if (!config[stream]) return "disabled";
  const b = breakers.get(`${stream}:${projectId}`);
  return b?.open ? "open" : "closed";
}

/** Drop breakers idle longer than maxIdleMs — bounds memory as projects churn. */
export function sweep(now: number = Date.now(), maxIdleMs = 10 * 60_000): void {
  for (const [key, b] of breakers) if (now - b.lastSeen >= maxIdleMs) breakers.delete(key);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic idle-breaker sweep (idempotent). Call once at server startup. */
export function startEmbedThrottleSweep(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => sweep(), intervalMs);
  timer.unref?.();
}

/** Test helper: clear all breaker state and reload config from env. */
export function _reset(): void {
  breakers.clear();
  config = loadConfig();
}

/** Test helper: override a stream's resolved config (null = disabled). */
export function _configure(stream: EmbedStream, cfg: StreamConfig | null): void {
  config[stream] = cfg;
}
