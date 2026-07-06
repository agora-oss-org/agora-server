// DSN-keyed pool registry (spec §4.1). Consumed by Phase 1's tenant-directory path;
// Phase 0 ships + tests it but production code doesn't call it yet.
// Read-mostly by design: entries are added and looked up, never reassigned under a
// request — the contamination-safety invariant (spec §2, §10).
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { logger } from "../lib/logger.js";
import type { Db } from "./context.js";
import * as schema from "./schema/index.js";

type Entry = { client: Sql; db: Db; lastUsed: number };

const registry = new Map<string, Entry>();

// Entries used within this window are never evicted — covers the execution window of
// detached fire-and-forget work that may still hold the handle (spec §4.1).
const EVICT_MIN_IDLE_MS = 5 * 60 * 1000;

function maxPools(): number {
  const n = Number(process.env.MAX_POOLS ?? 50);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

export function getDbForDsn(dsn: string): Db {
  let entry = registry.get(dsn);
  if (!entry) {
    if (registry.size >= maxPools()) evictLru();
    // Every runtime DSN is assumed to sit behind a transaction-mode pooler:
    // prepare:false is non-negotiable; small per-process pool, the pooler owns the ceiling.
    const client = postgres(dsn, { prepare: false, max: 5, idle_timeout: 30, max_lifetime: 1800 });
    entry = { client, db: drizzle(client, { schema }), lastUsed: Date.now() };
    registry.set(dsn, entry);
    logger.debug({ pools: registry.size }, "tenant db pool created");
  }
  entry.lastUsed = Date.now();
  return entry.db;
}

function evictLru(): void {
  let oldestKey: string | undefined;
  let oldest = Infinity;
  const now = Date.now();
  for (const [key, e] of registry) {
    if (now - e.lastUsed <= EVICT_MIN_IDLE_MS) continue; // recently used — never evict
    if (e.lastUsed < oldest) {
      oldest = e.lastUsed;
      oldestKey = key;
    }
  }
  if (!oldestKey) return; // everything is live; allow growth past the cap rather than kill a pool
  const e = registry.get(oldestKey);
  registry.delete(oldestKey);
  logger.debug({ pools: registry.size }, "tenant db pool evicted");
  // end() waits for in-flight queries; best-effort — never throw from eviction
  void e?.client.end({ timeout: 5 }).catch(() => {});
}

// Shutdown/test helper: drain and forget every pool.
export async function endAllPools(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(entries.map((e) => e.client.end({ timeout: 5 }).catch(() => {})));
}
