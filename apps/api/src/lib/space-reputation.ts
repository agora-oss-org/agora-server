import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";

/** Fill a userId → reputation map from raw rows, defaulting every requested id to 0. Pure. */
export function fillReputationMap(
  rows: { userId: string; reputation: number }[],
  userIds: string[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const id of userIds) map.set(id, 0);
  for (const r of rows) if (map.has(r.userId)) map.set(r.userId, r.reputation);
  return map;
}

/**
 * Batch-load per-space reputation for a set of users. Returns a map with EVERY requested id present
 * (absent → 0). `includeDescendants` rolls the score up over the space's subtree (Task 4).
 */
export async function loadSpaceReputations(
  projectId: string,
  spaceId: string,
  includeDescendants: boolean,
  userIds: string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  if (includeDescendants) {
    // Filled in Task 4.
    throw new Error("descendant rollup not yet implemented");
  }
  // Drizzle's sql template renders an interpolated JS array as a parenthesized list of params
  // (`($1, $2)`), not a Postgres array literal — so `= any(${ids}::uuid[])` breaks ("cannot cast
  // type record to uuid[]"). sql.join keeps each id its own bound, explicitly-cast param.
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await getDb().execute<{ user_id: string; reputation: number }>(sql`
    select user_id, reputation from space_reputation
    where project_id = ${projectId}::uuid and space_id = ${spaceId}::uuid
      and user_id in (${idList})`);
  return fillReputationMap(
    [...rows].map((r) => ({ userId: r.user_id, reputation: Number(r.reputation) })),
    ids,
  );
}
