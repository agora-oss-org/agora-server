// Per-user push opt-out set (migration 0060). Empty set = all push types enabled (default).
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { pushNotificationPreferences } from "../db/schema/index.js";

/** The user's opt-OUT set. Empty when no row exists (all-on). */
export async function loadDisabledTypes(projectId: string, userId: string): Promise<Set<string>> {
  const [row] = await getDb().select({ disabledTypes: pushNotificationPreferences.disabledTypes })
    .from(pushNotificationPreferences)
    .where(and(eq(pushNotificationPreferences.projectId, projectId), eq(pushNotificationPreferences.userId, userId)))
    .limit(1);
  return new Set(row?.disabledTypes ?? []);
}

export function isTypeDisabled(disabled: Set<string>, type: string): boolean {
  return disabled.has(type);
}
