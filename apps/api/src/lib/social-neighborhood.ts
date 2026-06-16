// Neighborhood — the most personal Garden lens (docs/AGORA-SOCIAL.md, SOCIAL-GRAPH.md §3). Zoom to
// YOURSELF: your own named ties, each rendered with its DYADIC brightness B(me, them). Self-view only;
// the caller's project-specific user id anchors the query, so results are inherently in-project (a
// follow/connection only forms within a project). Reuses PR3's warmth math + read-time decay + age
// cutoff, applied per dyad instead of aggregated over the project (cf. social-weather.ts).
//
// Asymmetry rule (cheat-sheet #6): we return B(me, them) — *your tie's* warmth — NEVER the friend's
// global S_p. Friction only DIMS an existing tie (FLOOR-bounded → unreadable); it never creates one.
import type { Driver } from "neo4j-driver";
import { and, eq, inArray } from "drizzle-orm";
import type {
  NeighborhoodTie, NeighborhoodTieKind, ResolvedSocialConfig, SocialNeighborhood,
} from "@agora-server/contract";
import { db } from "../db/index.js";
import { profiles } from "../db/schema/index.js";
import { getNeo4j } from "./neo4j.js";
import { pairBrightness, AGE_CUTOFF_HALF_LIVES, LN2, DAY_MS } from "./social-weather.js";

type HalfLives = Pick<ResolvedSocialConfig, "warmthHalfLifeDays" | "frictionHalfLifeDays">;

export interface NeighborhoodRow {
  userId: string;
  tieKinds: NeighborhoodTieKind[];
  w: number; // decayed positive-sentiment sum across the dyad (both directions), ≥ 0
  f: number; // decayed friction sum (negative INTERACTED + FRICTION, both directions), ≥ 0
}

// Neo4j relationship-type label → public tie kind. Canonical order for stable, testable output.
const TIE_KIND: Record<string, NeighborhoodTieKind> = {
  FOLLOWS: "follow",
  CONNECTED: "connection",
  INTERACTED: "interaction",
};
const KIND_ORDER: readonly NeighborhoodTieKind[] = ["follow", "connection", "interaction"];

const round2 = (x: number): number => Math.round(x * 100) / 100;
// neo4j-driver may hand back Integer objects for whole numbers; sums are floats but stay defensive.
const toNum = (v: unknown): number =>
  typeof v === "number" ? v : ((v as { toNumber?: () => number })?.toNumber?.() ?? 0);

/** Pure: graph rows → scored ties (dyadic brightness, 2dp), brightest-first. */
export function neighborhoodFromRows(
  rows: NeighborhoodRow[],
): Array<{ userId: string; tieKinds: NeighborhoodTieKind[]; brightness: number }> {
  return rows
    .map((r) => ({ userId: r.userId, tieKinds: r.tieKinds, brightness: round2(pairBrightness(r.w, r.f)) }))
    .sort((a, b) => b.brightness - a.brightness);
}

// Dyad-undirected, project-scoped, age-cut. A person is a tie via a FOLLOWS/CONNECTED edge (always) or a
// recent INTERACTED edge; FRICTION only feeds `f`, it never appears in the tie-set MATCH (no scarlet
// letter — friction is not structure). w/f reuse the exact decay of WEATHER_PAIRS_CYPHER.
export const NEIGHBORHOOD_CYPHER = `
MATCH (me:User {id: $me})-[rel:FOLLOWS|CONNECTED|INTERACTED]-(x:User)
WHERE x.id <> $me AND (
  type(rel) IN ['FOLLOWS','CONNECTED']
  OR (rel.projectId = $projectId AND rel.at >= $ageCutoff AND rel.at <= $asOf)
)
WITH me, x, collect(DISTINCT type(rel)) AS relTypes
OPTIONAL MATCH (me)-[ri:INTERACTED]-(x)
  WHERE ri.projectId = $projectId AND ri.at >= $ageCutoff AND ri.at <= $asOf
    AND ri.sentiment IS NOT NULL AND ri.sentiment <> 0
WITH me, x, relTypes,
  sum(CASE WHEN ri.sentiment > 0
       THEN ri.sentiment * exp(-${LN2} * (toFloat($asOf - ri.at) / ${DAY_MS}.0) / toFloat($warmthHalfLifeDays))
       ELSE 0.0 END) AS w,
  sum(CASE WHEN ri.sentiment < 0
       THEN -ri.sentiment * exp(-${LN2} * (toFloat($asOf - ri.at) / ${DAY_MS}.0) / toFloat($frictionHalfLifeDays))
       ELSE 0.0 END) AS fI
OPTIONAL MATCH (me)-[rf:FRICTION]-(x)
  WHERE rf.projectId = $projectId AND rf.at >= $ageCutoff AND rf.at <= $asOf
WITH x, relTypes, w, fI,
  sum(coalesce(rf.weight, 1.0) * exp(-${LN2} * (toFloat($asOf - rf.at) / ${DAY_MS}.0) / toFloat($frictionHalfLifeDays))) AS fF
RETURN x.id AS userId, relTypes AS tieKinds, w AS w, (fI + fF) AS f`;

interface ProfileLite { id: string; username: string | null; name: string | null; avatar: string | null }

async function fetchProfiles(projectId: string, ids: string[]): Promise<Map<string, ProfileLite>> {
  const map = new Map<string, ProfileLite>();
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return map;
  const rows = await db
    .select({ id: profiles.id, username: profiles.username, name: profiles.name, avatar: profiles.avatar })
    .from(profiles)
    .where(and(eq(profiles.projectId, projectId), inArray(profiles.id, uniq)));
  for (const r of rows) map.set(r.id, r);
  return map;
}

function mapTieKinds(raw: unknown): NeighborhoodTieKind[] {
  return ((raw as string[]) ?? [])
    .map((t) => TIE_KIND[t])
    .filter((k): k is NeighborhoodTieKind => !!k)
    .sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
}

/** The caller's Neighborhood: their own ties with dyadic brightness, brightest-first. Throws when Neo4j
 *  is unconfigured/unreachable (the route maps that to 503). `opts` exists for tests (stub driver, frozen
 *  clock, stub profile fetch). Computed live — bounded by the caller's degree, so no cache. */
export async function getSocialNeighborhood(
  projectId: string,
  userId: string,
  cfg: HalfLives,
  opts: {
    driver?: Driver;
    nowMs?: number;
    fetchProfiles?: (ids: string[]) => Promise<Map<string, ProfileLite>>;
  } = {},
): Promise<SocialNeighborhood> {
  const now = opts.nowMs ?? Date.now();
  const driver = opts.driver ?? getNeo4j();
  if (!driver) throw new Error("neo4j read client is not configured");
  const ageCutoff = now - AGE_CUTOFF_HALF_LIVES * cfg.warmthHalfLifeDays * DAY_MS;
  const { records } = await driver.executeQuery(NEIGHBORHOOD_CYPHER, {
    me: userId,
    projectId,
    asOf: now,
    ageCutoff,
    warmthHalfLifeDays: cfg.warmthHalfLifeDays,
    frictionHalfLifeDays: cfg.frictionHalfLifeDays,
  });
  const rows: NeighborhoodRow[] = (records as Array<{ get: (k: string) => unknown }>).map((r) => ({
    userId: String(r.get("userId")),
    tieKinds: mapTieKinds(r.get("tieKinds")),
    w: toNum(r.get("w")),
    f: toNum(r.get("f")),
  }));
  const scored = neighborhoodFromRows(rows);
  const resolve = opts.fetchProfiles ?? ((ids: string[]) => fetchProfiles(projectId, ids));
  const byId = await resolve(scored.map((s) => s.userId));
  const ties: NeighborhoodTie[] = [];
  for (const s of scored) {
    const p = byId.get(s.userId);
    if (!p) continue; // deleted/missing profile — nothing to render
    ties.push({
      userId: s.userId,
      username: p.username ?? null,
      name: p.name ?? null,
      avatar: p.avatar ?? null,
      brightness: s.brightness,
      tieKinds: s.tieKinds,
    });
  }
  return { ties, asOf: new Date(now).toISOString() };
}
