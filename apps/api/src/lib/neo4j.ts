// Optional Neo4j (DozerDB) driver — the social graph's READ side (docs/SOCIAL-GRAPH.md §3). The
// scorer service is the graph's only writer; the API never writes. Lazily constructed and fail-soft,
// mirroring lib/redis.ts: NEO4J_URI unset → null, and social read endpoints respond 503.
import neo4j, { Neo4jError, type Driver } from "neo4j-driver";
import { env } from "./env.js";
import { logger } from "./logger.js";

let driver: Driver | null = null;
let attempted = false;

/** Whether the social-graph read side is configured at all (cheap, no connection). */
export function neo4jEnabled(): boolean {
  return !!env.NEO4J_URI;
}

/** Whether an error came from the Neo4j driver (network/auth/query — incl. ServiceUnavailable),
 *  as opposed to a bug in our own code. Routes map driver errors to 503 and rethrow the rest. */
export function isNeo4jError(err: unknown): boolean {
  return err instanceof Neo4jError;
}

/** The shared read-side driver, or null when NEO4J_URI is unset. Constructed once; the driver
 *  manages its own connection pool and reconnects, so a down Neo4j surfaces as query errors
 *  (handled per-request), never a crashed boot. */
export function getNeo4j(): Driver | null {
  if (attempted) return driver;
  attempted = true;
  if (!env.NEO4J_URI) return null;
  driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD ?? ""), {
    connectionAcquisitionTimeout: 5_000, // fail fast instead of hanging when Neo4j is down
  });
  logger.info("neo4j: social-graph read client enabled");
  return driver;
}
