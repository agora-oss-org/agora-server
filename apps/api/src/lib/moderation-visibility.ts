// Read-path enforcement for moderation-"removed" content. Removed entities/comments must not reach
// normal readers: they're excluded from list queries (excludeRemovedSql) and 404 on single reads
// (shouldHide) — "hide completely" is the only behavior. Operators bypass entirely (they review
// removed content via the admin queue).
import type { Context } from "hono";
import { or, isNull, ne, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { entities, comments } from "../db/schema/index.js";

type Ctx = Context<{ Variables: Variables }>;

export interface RemovedPolicy {
  privileged: boolean; // operator → sees removed content (for review); skips all gating
}

/** Resolve the per-request removed-content policy (whether the caller is privileged). */
export async function removedPolicy(c: Ctx): Promise<RemovedPolicy> {
  return { privileged: c.var.auth?.isOperator === true };
}

/**
 * SQL to exclude moderation-removed rows from a list query — unless the viewer is privileged. Returns
 * undefined for operators so the caller can `if (cond) conds.push(cond)`. `<> 'removed'` alone would
 * drop NULLs, hence the OR.
 */
export function excludeRemovedSql(
  p: RemovedPolicy,
  table: typeof entities | typeof comments,
): SQL | undefined {
  if (p.privileged) return undefined;
  return or(isNull(table.moderationStatus), ne(table.moderationStatus, "removed"));
}

/** True when a single removed item should 404 for this viewer (non-privileged). */
export function shouldHide(p: RemovedPolicy, moderationStatus: string | null | undefined): boolean {
  return !p.privileged && moderationStatus === "removed";
}
