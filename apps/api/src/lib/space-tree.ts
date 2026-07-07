import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";

/** Space id + all non-deleted descendant ids (self included), via a recursive CTE over parent_space_id.
 *  Bounded in practice by MAX_SPACE_DEPTH. Parameterized — no interpolation. */
export async function resolveSpaceSubtree(projectId: string, spaceId: string): Promise<string[]> {
  const rows = (await getDb().execute(sql`
    with recursive sub as (
      select id from spaces where project_id = ${projectId}::uuid and id = ${spaceId}::uuid and deleted_at is null
      union all
      select s.id from spaces s join sub on s.parent_space_id = sub.id
      where s.project_id = ${projectId}::uuid and s.deleted_at is null
    )
    select id from sub
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}
