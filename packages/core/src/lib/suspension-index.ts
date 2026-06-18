// Redis-backed suspension index — a SET ("suspended:profiles") of suspended profileIds, for an O(1)
// membership check on the hot path (requireAuth + the realtime handshakes) instead of a per-request
// Postgres read.
//
// ENABLED only when REDIS_URL is set. When DISABLED, callers (lib/suspensions.ts) fall back to the
// authoritative DB read — so a single-replica @agora/api and the hermetic integration suite work with
// no Redis. When ENABLED the read is FAIL-CLOSED: a Redis error throws 503 (the request is denied, never
// silently allowed) and there is deliberately NO DB fallback for a configured-but-down Redis — that
// would be a fail-OPEN risk surface. (@agora/secure-chat treats Redis as a hard dependency; see its
// README + docker-compose.) The index is maintained by: hydrate-on-boot (atomic rebuild), write-through
// on suspend/lift (lib/suspensions.ts in @agora/api), and a reconcile cron (/internal/cron/sync-suspensions).
import { getRedis } from "./redis.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { Errors } from "../http/errors.js";

const KEY = "suspended:profiles";
const TMP = "suspended:profiles:rebuild";

let ready = false;

/** The Redis suspension index is active iff REDIS_URL is configured. */
export function suspensionIndexEnabled(): boolean {
  return !!env.REDIS_URL;
}

/** Boot readiness gate: serve traffic only after a successful hydrate, so an un-hydrated (empty) set
 *  never fails OPEN — a suspended user must not slip through before the index is populated. */
export function markSuspensionIndexReady(): void {
  ready = true;
}
export function suspensionIndexReady(): boolean {
  return ready;
}

/** FAIL-CLOSED membership check. Throws 503 when Redis is unreachable (request denied, never allowed). */
export async function isSuspendedRedis(profileId: string): Promise<boolean> {
  const r = getRedis();
  if (!r) throw Errors.unavailable("suspension/index-unavailable", "Suspension index unavailable");
  try {
    return (await r.sismember(KEY, profileId)) === 1;
  } catch (err) {
    logger.error("suspension index read failed (failing closed)");
    logger.debug({ err, profileId }, "suspension index read failed (failing closed)");
    throw Errors.unavailable("suspension/index-unavailable", "Suspension index unavailable");
  }
}

/** Best-effort write-through on suspend. Failure is logged, NOT thrown: the boot hydrate + reconcile
 *  cron are the backstops, and suspendUser already revokes refresh families (TTL-bounds access). */
export async function addSuspended(profileId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.sadd(KEY, profileId);
  } catch (err) {
    logger.error("suspension index write (add) failed");
    logger.debug({ err, profileId }, "suspension index write (add) failed");
  }
}

/** Best-effort write-through on lift (mirrors addSuspended). */
export async function removeSuspended(profileId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.srem(KEY, profileId);
  } catch (err) {
    logger.error("suspension index write (remove) failed");
    logger.debug({ err, profileId }, "suspension index write (remove) failed");
  }
}

/** Atomically REPLACE the index with `ids` (temp key + RENAME), so a reconcile/hydrate never leaves a
 *  half-built set visible. Empty `ids` → DEL the key (an empty Redis SET is just a missing key). No-op
 *  when the index is disabled. */
export async function rebuildSuspendedSet(ids: string[]): Promise<void> {
  const r = getRedis();
  if (!r) return;
  if (ids.length === 0) {
    await r.del(KEY);
    return;
  }
  await r.multi().del(TMP).sadd(TMP, ...ids).rename(TMP, KEY).exec();
}
