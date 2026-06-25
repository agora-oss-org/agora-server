// Shared per-project GDS (Graph Data Science) graph projection. The community/structure subgraph for a
// project is the INTERACTED ∪ FOLLOWS ∪ CONNECTED edges among the project's profile-id set — FRICTION is
// excluded (friction is never structure, §07). User nodes carry no projectId, so scope is the Postgres
// `userIds` set passed in. This factors the feature-detect → project → drop-in-`finally` lifecycle shared
// by the Constellation's Louvain and the admin analytics' PageRank/betweenness, so the projection is
// defined in exactly one place. Returns `fn`'s result, or `null` when OpenGDS is absent/unusable (the
// caller degrades gracefully — SOCIAL-GRAPH.md §6).
import type { Driver, Session } from "neo4j-driver";
import { logger } from "./logger.js";
import { neo4jDatabase } from "./neo4j.js";

const GDS_NODE_QUERY = "MATCH (u:User) WHERE u.id IN $userIds RETURN id(u) AS id";
const GDS_REL_QUERY =
  `MATCH (a:User)-[:INTERACTED|FOLLOWS|CONNECTED]-(b:User)
     WHERE a.id IN $userIds AND b.id IN $userIds
     RETURN id(a) AS source, id(b) AS target`;

/** Coerce a Neo4j numeric (number or Integer-like {toNumber}) to a JS number. */
export const toNum = (v: unknown): number =>
  typeof v === "number" ? v : ((v as { toNumber?: () => number })?.toNumber?.() ?? 0);

/** Build `Map<userId, score>` from `YIELD nodeId, score RETURN gds.util.asNode(nodeId).id AS userId, score`. */
export function scoresFromRecords(records: { get(key: string): unknown }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of records) m.set(String(r.get("userId")), toNum(r.get("score")));
  return m;
}

/** Project the per-project GDS graph (named `graphName`), run `fn(session, graphName)`, and ALWAYS drop the
 *  projection. Feature-detects OpenGDS first; any GDS/projection error degrades to `null`. */
export async function withProjectedGdsGraph<T>(
  driver: Driver,
  graphName: string,
  userIds: string[],
  fn: (session: Session, graphName: string) => Promise<T>,
): Promise<T | null> {
  const session = driver.session({ database: neo4jDatabase() });
  const dropGraph = async () => {
    try {
      await session.run("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", { g: graphName });
    } catch { /* best-effort */ }
  };
  try {
    await session.run("RETURN gds.version()"); // feature-detect — throws if OpenGDS isn't installed
    await dropGraph(); // clear any stale projection from a crashed prior run
    await session.run(
      `CALL gds.graph.project.cypher($g, $nodeQuery, $relQuery,
         { parameters: { userIds: $userIds }, validateRelationships: false }
       ) YIELD graphName RETURN graphName`,
      { g: graphName, nodeQuery: GDS_NODE_QUERY, relQuery: GDS_REL_QUERY, userIds },
    );
    return await fn(session, graphName);
  } catch (err) {
    // Degrade gracefully (SOCIAL-GRAPH.md §6): GDS missing or a projection error → caller falls back.
    logger.warn("social: GDS unavailable or projection failed; caller will degrade");
    logger.debug({ err }, "social: GDS projection failed");
    return null;
  } finally {
    await dropGraph();
    await session.close();
  }
}
