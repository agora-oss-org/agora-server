// Request-metering accumulator for the admin dashboard "App metering" cards (API Calls / Client
// Egress / Avg Response Time). Requests increment an in-memory per-(project, month) bucket; a timer
// flushes the deltas to `api_usage` with an additive upsert. This keeps the hot path DB-free and
// lets concurrent API replicas each flush their own deltas safely (the upsert sums them).
//
// Trade-off: a crash loses the unflushed window (≤ FLUSH_INTERVAL_MS of counts) — acceptable for
// usage metrics. On flush failure the snapshot is merged back so nothing is dropped on transient errors.
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

interface Bucket {
  requests: number;
  egressBytes: number;
  durationMs: number;
  errors: number;
}

const FLUSH_INTERVAL_MS = 10_000;
const buckets = new Map<string, Bucket>(); // key: `${projectId}|${YYYY-MM-01}`

/** First day of the current month in UTC, as `YYYY-MM-01` (matches the `date` column). */
function monthKey(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

function emptyBucket(): Bucket {
  return { requests: 0, egressBytes: 0, durationMs: 0, errors: 0 };
}

/** Record one request's contribution. Cheap + synchronous (no I/O). */
export function recordRequest(projectId: string, sample: { bytes: number; durationMs: number; error: boolean }): void {
  const key = `${projectId}|${monthKey()}`;
  const b = buckets.get(key) ?? emptyBucket();
  b.requests += 1;
  b.egressBytes += sample.bytes;
  b.durationMs += sample.durationMs;
  if (sample.error) b.errors += 1;
  buckets.set(key, b);
}

function mergeBack(snapshot: [string, Bucket][]): void {
  for (const [key, b] of snapshot) {
    const cur = buckets.get(key) ?? emptyBucket();
    cur.requests += b.requests;
    cur.egressBytes += b.egressBytes;
    cur.durationMs += b.durationMs;
    cur.errors += b.errors;
    buckets.set(key, cur);
  }
}

let flushing = false;

/** Flush accumulated deltas to `api_usage`. Safe to call concurrently (guarded). */
export async function flushMetrics(): Promise<void> {
  if (flushing || buckets.size === 0) return;
  flushing = true;
  const snapshot = [...buckets.entries()];
  buckets.clear();
  try {
    for (const [key, b] of snapshot) {
      const [projectId, month] = key.split("|") as [string, string];
      // duration_ms_total is bigint; the accumulator carries fractional ms (performance.now()), so
      // round at the DB boundary. Sub-ms loss on a summed total is irrelevant to avg-latency.
      await db.execute(sql`
        insert into api_usage (project_id, month, requests, egress_bytes, duration_ms_total, errors)
        values (${projectId}::uuid, ${month}::date, ${b.requests}, ${b.egressBytes}, ${Math.round(b.durationMs)}, ${b.errors})
        on conflict (project_id, month) do update set
          requests          = api_usage.requests + excluded.requests,
          egress_bytes      = api_usage.egress_bytes + excluded.egress_bytes,
          duration_ms_total = api_usage.duration_ms_total + excluded.duration_ms_total,
          errors            = api_usage.errors + excluded.errors,
          updated_at        = now()
      `);
    }
  } catch (e) {
    mergeBack(snapshot); // don't lose counts on a transient DB error
    console.error("[metrics] flush failed:", e);
  } finally {
    flushing = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic flush loop (idempotent). Call once at server startup. */
export function startMetricsFlush(): void {
  if (timer) return;
  timer = setInterval(() => void flushMetrics(), FLUSH_INTERVAL_MS);
  timer.unref?.(); // don't keep the process alive just for metrics
}
