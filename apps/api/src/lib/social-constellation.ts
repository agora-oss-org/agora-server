// Constellation — the anonymous *shape* of a community (docs/AGORA-SOCIAL.md §12). Materialized on a slow
// SEASONAL cadence (never per-load — §12) by the cron, read straight from the social_constellation table.
// Clustering uses GDS Louvain over the warmth graph when OpenGDS is present, degrading to a by-space
// heuristic otherwise (SOCIAL-GRAPH.md §6). FRICTION is excluded from clustering — friction never renders
// as structure (§07). Each blob is k-anonymized (clusters below the floor are dropped), bucketed in size,
// and tinted by its members' mean S_p — reusing the Weather warmth math (lib/social-weather.ts).
import type { Driver } from "neo4j-driver";
import { and, desc, eq } from "drizzle-orm";
import {
  adaptiveConstellationFloor,
  BLOB_SIZE_BUCKETS, WEATHER_BANDS,
  type BlobSizeBucket, type ConstellationBlob, type SocialConstellation,
} from "@agora-server/contract";
import { getDb } from "../db/index.js";
import { profiles, projects, spaceMembers, socialConstellation } from "../db/schema/index.js";
import { getNeo4j, isNeo4jError } from "./neo4j.js";
import { getSocialConfig } from "./social-config.js";
import { toNum, withProjectedGdsGraph } from "./social-gds.js";
import {
  B_FLOOR, DAY_MS, fetchWarmthPairs, personScoresFromPairs, weatherBand,
} from "./social-weather.js";
import { logger } from "./logger.js";

// §12 seasonal cadence: a project is recomputed at most this often. A weekly cron with this in-lib gate
// makes most runs a cheap no-op (and self-heals a missed run on the next pass).
export const CONSTELLATION_EPOCH_DAYS = 42; // ~6 weeks

const GRAPH_NAME_PREFIX = "constellation_";

// ── Pure helpers (unit-tested; no IO) ────────────────────────────────────────

/** Coarse size bucket (one of the §12 protections — never an exact count). Caller only passes n ≥ kFloor. */
export function sizeBucket(n: number): BlobSizeBucket {
  if (n >= 100) return BLOB_SIZE_BUCKETS[4];
  if (n >= 50) return BLOB_SIZE_BUCKETS[3];
  if (n >= 20) return BLOB_SIZE_BUCKETS[2];
  if (n >= 10) return BLOB_SIZE_BUCKETS[1];
  return BLOB_SIZE_BUCKETS[0];
}

/** Suppress sub-kFloor clusters (k-anonymity), bucket size, band warmth (mean member S_p; absent member →
 *  floor), and order deterministically (largest+warmest first — the client randomizes layout per load,
 *  §12). `sP` is the per-person warmth map from the Weather machinery. Returns the rendered blobs plus the
 *  total clustered headcount (pre-suppression, for the snapshot's debug column). */
export function blobsFromCommunities(
  communities: Map<string, string[]>,
  sP: Map<string, number>,
  kFloor: number,
): { blobs: ConstellationBlob[]; memberCount: number } {
  const blobs: ConstellationBlob[] = [];
  let memberCount = 0;
  for (const members of communities.values()) {
    memberCount += members.length;
    if (members.length < kFloor) continue; // k-anonymity: a cluster smaller than the floor is omitted
    const warmth = members.reduce((s, m) => s + (sP.get(m) ?? B_FLOOR), 0) / members.length;
    blobs.push({ size: sizeBucket(members.length), warmth: weatherBand(warmth) });
  }
  const rank = (b: ConstellationBlob) =>
    BLOB_SIZE_BUCKETS.indexOf(b.size) * 10 + WEATHER_BANDS.indexOf(b.warmth);
  blobs.sort((a, b) => rank(b) - rank(a));
  return { blobs, memberCount };
}

// ── Clustering (IO) ──────────────────────────────────────────────────────────

/** GDS Louvain over the project's warmth/structure graph (INTERACTED ∪ FOLLOWS ∪ CONNECTED — FRICTION
 *  excluded). Scoped by the Postgres profile-id set (User nodes carry no projectId). Returns communityId →
 *  member ids, or null when GDS is absent/unusable (→ caller falls back to by-space). */
export async function louvainCommunities(
  driver: Driver, projectId: string, userIds: string[],
): Promise<Map<string, string[]> | null> {
  const graphName = GRAPH_NAME_PREFIX + projectId.replace(/-/g, "");
  return withProjectedGdsGraph(driver, graphName, userIds, async (session, g) => {
    const res = await session.run(
      `CALL gds.louvain.stream($g) YIELD nodeId, communityId
       RETURN gds.util.asNode(nodeId).id AS userId, communityId`,
      { g },
    );
    const communities = new Map<string, string[]>();
    for (const rec of res.records) {
      const userId = String(rec.get("userId"));
      const community = String(toNum(rec.get("communityId")));
      const bucket = communities.get(community);
      if (bucket) bucket.push(userId);
      else communities.set(community, [userId]);
    }
    return communities;
  });
}

/** Fallback clustering: each space is a community (active members), grouped from Postgres. */
async function spaceCommunities(projectId: string): Promise<Map<string, string[]>> {
  const rows = await getDb()
    .select({ spaceId: spaceMembers.spaceId, userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.projectId, projectId), eq(spaceMembers.status, "active")));
  const communities = new Map<string, string[]>();
  for (const r of rows) {
    const bucket = communities.get(r.spaceId);
    if (bucket) bucket.push(r.userId);
    else communities.set(r.spaceId, [r.userId]);
  }
  return communities;
}

// ── Materialization (the seasonal cron's work) ───────────────────────────────

async function materializeProject(
  driver: Driver, projectId: string, now: number, force: boolean,
): Promise<boolean> {
  const cfg = await getSocialConfig(projectId);
  if (!cfg.graphEnabled || !cfg.constellationEnabled) return false;

  if (!force) {
    const [last] = await getDb()
      .select({ computedAt: socialConstellation.computedAt })
      .from(socialConstellation)
      .where(eq(socialConstellation.projectId, projectId))
      .orderBy(desc(socialConstellation.computedAt))
      .limit(1);
    if (last && now - last.computedAt.getTime() < CONSTELLATION_EPOCH_DAYS * DAY_MS) return false; // not due
  }

  const userRows = await getDb().select({ id: profiles.id }).from(profiles).where(eq(profiles.projectId, projectId));
  const userIds = userRows.map((r) => r.id);
  if (userIds.length === 0) return false;

  const louvain = await louvainCommunities(driver, projectId, userIds);
  const communities = louvain ?? (await spaceCommunities(projectId));
  const method: "louvain" | "space" = louvain ? "louvain" : "space";

  const sP = personScoresFromPairs(await fetchWarmthPairs(driver, projectId, cfg, now));
  const kFloor = cfg.constellationKFloor ?? adaptiveConstellationFloor(userIds.length);
  const { blobs, memberCount } = blobsFromCommunities(communities, sP, kFloor);

  const computedAt = new Date(now);
  await getDb()
    .insert(socialConstellation)
    .values({ projectId, computedAt, method, blobs, memberCount })
    .onConflictDoUpdate({
      target: [socialConstellation.projectId, socialConstellation.computedAt],
      set: { method, blobs, memberCount, updatedAt: computedAt },
    });
  logger.info({ projectId, method, blobs: blobs.length, memberCount }, "social: constellation materialized");
  return true;
}

/** Recompute + snapshot the Constellation for one project (or all). Mirrors lib/community-stats.ts:
 *  idempotent, self-healing, and a no-op for projects whose snapshot is younger than the epoch. No-op
 *  (logged) when Neo4j is unconfigured — the warmth tint needs the graph. */
export async function rollupConstellation(
  projectId?: string | null,
  opts: { driver?: Driver | null; nowMs?: number; force?: boolean } = {},
): Promise<{ projects: number; materialized: number }> {
  const now = opts.nowMs ?? Date.now();
  const driver = opts.driver !== undefined ? opts.driver : getNeo4j();
  if (!driver) {
    logger.warn("social: constellation rollup skipped (neo4j not configured)");
    return { projects: 0, materialized: 0 };
  }
  const ids = projectId
    ? [projectId]
    : (await getDb().select({ id: projects.id }).from(projects)).map((r) => r.id);

  let materialized = 0;
  for (const id of ids) {
    try {
      if (await materializeProject(driver, id, now, opts.force ?? false)) materialized++;
    } catch (err) {
      if (!isNeo4jError(err)) throw err; // a programmer bug must not masquerade as a skipped project
      logger.warn("social: constellation rollup failed for a project");
      logger.debug({ err, projectId: id }, "social: constellation rollup failed");
    }
  }
  return { projects: ids.length, materialized };
}

/** The member-facing read: the LATEST materialized snapshot, or the "forming" sentinel (asOf null) when a
 *  project has never been computed. Reads Postgres only — no live graph query (the cadence is seasonal). */
export async function getConstellation(projectId: string): Promise<SocialConstellation> {
  const [row] = await getDb()
    .select()
    .from(socialConstellation)
    .where(eq(socialConstellation.projectId, projectId))
    .orderBy(desc(socialConstellation.computedAt))
    .limit(1);
  if (!row) return { blobs: [], asOf: null, method: null };
  return {
    blobs: row.blobs as ConstellationBlob[],
    asOf: row.computedAt.toISOString(),
    method: row.method as "louvain" | "space",
  };
}
