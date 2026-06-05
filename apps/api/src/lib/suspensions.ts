// User suspensions: the active-suspension predicate + the read/write helpers behind enforcement
// (middleware/auth.ts) and the operator suspend/lift endpoints (routes/users.ts). A suspension is
// ACTIVE when it has started and not yet ended; a null endDate is indefinite. Suspending revokes the
// user's refresh families too, so the session can't be renewed once the access token lapses.
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { userSuspensions } from "../db/schema/index.js";
import { revokeAllForProfile } from "./tokens.js";

type SuspensionRow = typeof userSuspensions.$inferSelect;

/** Pure predicate — the one place the "active" semantics live. startDate <= now < endDate (null=∞). */
export function isActiveSuspension(now: Date, row: { startDate: Date; endDate: Date | null }): boolean {
  return row.startDate.getTime() <= now.getTime() && (row.endDate === null || row.endDate.getTime() > now.getTime());
}

/** True when the profile has any currently-active suspension. Indexed point lookup by profile_id. */
export async function hasActiveSuspension(profileId: string): Promise<boolean> {
  const rows = await db
    .select({ startDate: userSuspensions.startDate, endDate: userSuspensions.endDate })
    .from(userSuspensions)
    .where(eq(userSuspensions.profileId, profileId));
  const now = new Date();
  return rows.some((r) => isActiveSuspension(now, r));
}

/** All suspension rows (active + history) for a profile, newest first. */
export async function listSuspensions(profileId: string): Promise<SuspensionRow[]> {
  const rows = await db.select().from(userSuspensions).where(eq(userSuspensions.profileId, profileId));
  return rows.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
}

/** Suspend a user (optionally until endDate) and revoke their refresh families so they can't renew. */
export async function suspendUser(profileId: string, opts: { reason?: string | null; endDate?: Date | null } = {}): Promise<SuspensionRow> {
  const [row] = await db.insert(userSuspensions).values({
    profileId,
    reason: opts.reason ?? null,
    endDate: opts.endDate ?? null,
  }).returning();
  await revokeAllForProfile(profileId);
  return row!;
}

/** Lift a user's suspensions by ending every currently-active row now (keeps history). Returns count. */
export async function liftSuspensions(profileId: string): Promise<number> {
  const now = new Date();
  const lifted = await db
    .update(userSuspensions)
    .set({ endDate: now })
    .where(and(
      eq(userSuspensions.profileId, profileId),
      or(isNull(userSuspensions.endDate), gt(userSuspensions.endDate, now)),
    ))
    .returning({ id: userSuspensions.id });
  return lifted.length;
}
