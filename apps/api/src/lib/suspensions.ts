// Suspension WRITE helpers (list / suspend / lift) used by the operator endpoints (routes/users.ts),
// plus a re-export of the shared READ path from @agora/core. The writes stay here because they revoke
// the user's refresh-token families (lib/tokens.ts — api-owned auth), which must not be pulled into the
// shared kernel. The read predicate + hasActiveSuspension live in @agora/core (shared with secure-chat).
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { userSuspensions } from "../db/schema/index.js";
import { revokeAllForProfile } from "./tokens.js";
import { addSuspended, removeSuspended } from "@agora/core/lib/suspension-index";

export { isActiveSuspension, hasActiveSuspension } from "@agora/core/lib/suspensions";

type SuspensionRow = typeof userSuspensions.$inferSelect;

/** All suspension rows (active + history) for a profile, newest first. */
export async function listSuspensions(profileId: string): Promise<SuspensionRow[]> {
  const rows = await getDb().select().from(userSuspensions).where(eq(userSuspensions.profileId, profileId));
  return rows.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
}

/** Suspend a user (optionally until endDate) and revoke their refresh families so they can't renew. */
export async function suspendUser(profileId: string, opts: { reason?: string | null; endDate?: Date | null } = {}): Promise<SuspensionRow> {
  const [row] = await getDb().insert(userSuspensions).values({
    profileId,
    reason: opts.reason ?? null,
    endDate: opts.endDate ?? null,
    startDate: new Date(), // pin to the Node clock — matches isActiveSuspension's comparand (avoids Postgres-vs-Node skew)
  }).returning();
  await revokeAllForProfile(profileId);
  await addSuspended(profileId); // Redis index write-through for instant enforcement (no-op if disabled)
  return row!;
}

/** Lift a user's suspensions by ending every currently-active row now (keeps history). Returns count. */
export async function liftSuspensions(profileId: string): Promise<number> {
  const now = new Date();
  const lifted = await getDb()
    .update(userSuspensions)
    .set({ endDate: now })
    .where(and(
      eq(userSuspensions.profileId, profileId),
      or(isNull(userSuspensions.endDate), gt(userSuspensions.endDate, now)),
    ))
    .returning({ id: userSuspensions.id });
  await removeSuspended(profileId); // Redis index write-through (no-op if disabled)
  return lifted.length;
}
