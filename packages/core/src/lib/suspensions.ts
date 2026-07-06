// User suspensions — the active-suspension predicate + the READ path behind enforcement
// (middleware/auth.ts requireAuth + the realtime handshakes in both apps). A suspension is ACTIVE
// when it has started and not yet ended; a null endDate is indefinite.
//
// The READ goes through the Redis suspension index when REDIS_URL is configured (O(1), fail-closed —
// see lib/suspension-index.ts); otherwise it falls back to the authoritative DB read. The WRITE helpers
// (suspend / lift / list) live in @agora/api (apps/api/src/lib/suspensions.ts), NOT here — they revoke
// refresh-token families (api-owned auth) and would drag lib/tokens.ts into this kernel; secure-chat
// only needs the read.
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { userSuspensions } from "../db/schema/index.js";
import {
  suspensionIndexEnabled, isSuspendedRedis, rebuildSuspendedSet, markSuspensionIndexReady,
} from "./suspension-index.js";

/** Pure predicate — the one place the "active" semantics live. startDate <= now < endDate (null=∞). */
export function isActiveSuspension(now: Date, row: { startDate: Date; endDate: Date | null }): boolean {
  return row.startDate.getTime() <= now.getTime() && (row.endDate === null || row.endDate.getTime() > now.getTime());
}

/** Authoritative DB read — used directly when the Redis index is disabled, and as the source of truth
 *  for (re)building the index (hydrate + cron). Indexed point lookup by profile_id. */
export async function hasActiveSuspensionDb(profileId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ startDate: userSuspensions.startDate, endDate: userSuspensions.endDate })
    .from(userSuspensions)
    .where(eq(userSuspensions.profileId, profileId));
  const now = new Date();
  return rows.some((r) => isActiveSuspension(now, r));
}

/** True when the profile has any currently-active suspension. Redis fast path (fail-closed) when the
 *  index is configured; otherwise the authoritative DB read. */
export async function hasActiveSuspension(profileId: string): Promise<boolean> {
  return suspensionIndexEnabled() ? isSuspendedRedis(profileId) : hasActiveSuspensionDb(profileId);
}

/** (Re)build the Redis index from the DB's currently-active suspensions, atomically. Idempotent — run
 *  on boot AND by the reconcile cron; one atomic rebuild simultaneously catches new suspensions, lifts,
 *  AND endDate expiries (no diffing). Marks the index ready (the boot readiness gate). When the index is
 *  disabled this is a no-op that still marks ready (callers use the DB read). */
export async function hydrateSuspensionIndex(): Promise<{ enabled: boolean; count: number }> {
  if (!suspensionIndexEnabled()) {
    markSuspensionIndexReady();
    return { enabled: false, count: 0 };
  }
  const rows = await getDb()
    .select({ profileId: userSuspensions.profileId, startDate: userSuspensions.startDate, endDate: userSuspensions.endDate })
    .from(userSuspensions);
  const now = new Date();
  const active = [...new Set(rows.filter((r) => isActiveSuspension(now, r)).map((r) => r.profileId))];
  await rebuildSuspendedSet(active);
  markSuspensionIndexReady();
  return { enabled: true, count: active.length };
}
