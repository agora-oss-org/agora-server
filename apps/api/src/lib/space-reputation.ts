import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { Errors } from "../http/errors.js";

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
  // Drizzle's sql template renders an interpolated JS array as a parenthesized list of params
  // (`($1, $2)`), not a Postgres array literal — so `= any(${ids}::uuid[])` breaks ("cannot cast
  // type record to uuid[]"). sql.join keeps each id its own bound, explicitly-cast param.
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  if (includeDescendants) {
    // CYCLE bounds the walk against a (app-prevented) parent_space_id cycle — for an acyclic tree
    // (the normal case) it changes no results, since every node is still visited exactly once.
    const rows = await getDb().execute<{ user_id: string; reputation: number }>(sql`
      with recursive subtree(id) as (
        select id from spaces where id = ${spaceId}::uuid and project_id = ${projectId}::uuid
        union all
        select s.id from spaces s
          join subtree t on s.parent_space_id = t.id
        where s.project_id = ${projectId}::uuid
      )
      cycle id set is_cycle using path
      select sr.user_id, sum(sr.reputation)::int as reputation
      from space_reputation sr
      where sr.project_id = ${projectId}::uuid
        and sr.space_id in (select id from subtree)
        and sr.user_id in (${idList})
      group by sr.user_id`);
    return fillReputationMap(
      [...rows].map((r) => ({ userId: r.user_id, reputation: Number(r.reputation) })),
      ids,
    );
  }
  const rows = await getDb().execute<{ user_id: string; reputation: number }>(sql`
    select user_id, reputation from space_reputation
    where project_id = ${projectId}::uuid and space_id = ${spaceId}::uuid
      and user_id in (${idList})`);
  return fillReputationMap(
    [...rows].map((r) => ({ userId: r.user_id, reputation: Number(r.reputation) })),
    ids,
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the SDK's space-reputation params (scaffold — no enrichment emitted this cycle).
 *  context endpoints: uuid | "none" | "context". user-direct (/users/*): uuid | "none" ("context" → 400).
 *  spaceReputationDescendants is only meaningful with an explicit uuid. Absent params are a no-op. */
export function validateSpaceReputationParams(
  raw: { spaceReputationId?: string; spaceReputationDescendants?: string },
  endpointClass: "context" | "user-direct",
): void {
  const id = raw.spaceReputationId;
  if (id !== undefined) {
    const isSpecial = id === "none" || id === "context";
    const isUuid = UUID_RE.test(id);
    if (!isSpecial && !isUuid) {
      throw Errors.badRequest("space-reputation/invalid-id", "spaceReputationId must be a uuid, 'none', or 'context'", "spaceReputationId");
    }
    if (id === "context" && endpointClass === "user-direct") {
      throw Errors.badRequest("space-reputation/context-not-allowed", "'context' is not valid on user-direct endpoints", "spaceReputationId");
    }
  }
  if (raw.spaceReputationDescendants === "true" && (id === undefined || id === "none" || id === "context")) {
    throw Errors.badRequest("space-reputation/descendants-needs-uuid", "spaceReputationDescendants requires an explicit space id", "spaceReputationDescendants");
  }
}
