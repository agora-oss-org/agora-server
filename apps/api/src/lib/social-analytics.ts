// Admin analytics — the corporate counterpart to the Garden (docs/AGORA-CORP.md; SOCIAL-GRAPH.md §7 Phase
// 4). Three operator-only, NAMED reports materialized on a weekly cadence (plus an operator-forced
// recompute), read straight from the social_analytics table:
//   • influence  — informal leaders (GDS PageRank) + bridge people (GDS betweenness)
//   • silos      — the named, space-mapped form of the Constellation's GDS Louvain clusters (no k-anon)
//   • engagement — per-person warmth-received S_p (reusing the Weather math) + a churn-risk trend
// Snapshots store RAW ids + scores only; names are hydrated fresh at read so they never go stale. Each
// report is corporate-tier-only, gated by its CORPORATE_ONLY_FLAG.
import type { Driver } from "neo4j-driver";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  SOCIAL_ANALYTICS_REPORTS,
  type ChurnRiskBand, type EngagementMember, type InfluenceMember, type ResolvedSocialConfig,
  type Silo, type SocialAnalyticsReport, type SocialEngagement, type SocialInfluence, type SocialSilos,
} from "@agora-server/contract";
import { getDb } from "../db/index.js";
import { profiles, projects, spaceMembers, spaces, socialAnalytics } from "../db/schema/index.js";
import { getNeo4j, isNeo4jError } from "./neo4j.js";
import { getSocialConfig } from "./social-config.js";
import { louvainCommunities } from "./social-constellation.js";
import { scoresFromRecords, withProjectedGdsGraph } from "./social-gds.js";
import { DAY_MS, fetchWarmthPairs, personScoresFromPairs } from "./social-weather.js";
import { fetchProfiles } from "./social-neighborhood.js";
import { logger } from "./logger.js";

// Weekly cadence: a project/report is recomputed at most this often (an operator forced-recompute bypasses
// it). The cron self-heals a missed run on the next pass.
export const ANALYTICS_EPOCH_DAYS = 7;
// How many trailing weekly snapshots the churn-risk trend looks back over.
export const ENGAGEMENT_TREND_WINDOW = 6;

const TOP_N = 25;          // leaders / bridges retained per influence snapshot
const SILO_MIN_SIZE = 2;   // a singleton "community" isn't a silo
const SILO_SPACES_LIMIT = 5;
const GRAPH_NAME_PREFIX = "analytics_";

/** Each report's corporate-tier flag — the single source for both the rollup's per-report gate and the
 *  route gates (read endpoints + the forced-recompute). */
export const ANALYTICS_REPORT_FLAG: Record<SocialAnalyticsReport, keyof ResolvedSocialConfig> = {
  influence: "influenceScoresEnabled",
  silos: "siloDetectionEnabled",
  engagement: "engagementScoresEnabled",
};

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;

// ── Pure helpers (unit-tested; no IO) ────────────────────────────────────────

/** Top `n` by score, highest first. */
export function topByScore(scores: Map<string, number>, n: number): { userId: string; score: number }[] {
  return [...scores.entries()]
    .map(([userId, score]) => ({ userId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/** Count how many of `memberIds` belong to each space, highest first (capped). `memberSpaces` maps a userId
 *  to the spaceIds they're an active member of. This is the human label for an otherwise-anonymous cluster. */
export function dominantSpaces(
  memberIds: string[],
  memberSpaces: Map<string, string[]>,
  limit = SILO_SPACES_LIMIT,
): { spaceId: string; memberCount: number }[] {
  const counts = new Map<string, number>();
  for (const m of memberIds) for (const s of memberSpaces.get(m) ?? []) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()]
    .map(([spaceId, memberCount]) => ({ spaceId, memberCount }))
    .sort((a, b) => b.memberCount - a.memberCount)
    .slice(0, limit);
}

/** Churn band from a trailing S_p series (oldest→newest). `delta` = current − baseline. Needs ≥2 points and
 *  a positive baseline; a relative decline >25% is "at-risk", >10% is "watch", otherwise "none". */
export function churnFromSeries(series: number[]): { delta: number; churnRisk: ChurnRiskBand } {
  if (series.length < 2) return { delta: 0, churnRisk: "none" };
  const baseline = series[0]!;
  const current = series[series.length - 1]!;
  const delta = round3(current - baseline);
  if (baseline <= 0) return { delta, churnRisk: "none" };
  const drop = (baseline - current) / baseline;
  const churnRisk: ChurnRiskBand = drop > 0.25 ? "at-risk" : drop > 0.1 ? "watch" : "none";
  return { delta, churnRisk };
}

// ── Stored payload shapes (raw ids + scores; names hydrated at read) ──────────

interface InfluenceRow { userId: string; pageRank: number; betweenness: number }
interface InfluencePayload { leaders: InfluenceRow[]; bridges: InfluenceRow[] }
interface SiloRow { id: string; size: number; memberIds: string[]; spaces: { spaceId: string; memberCount: number }[] }
interface SilosPayload { silos: SiloRow[] }
interface EngagementPayload { members: { userId: string; sP: number }[] }

// ── GDS scoring (IO) ──────────────────────────────────────────────────────────

/** PageRank + betweenness over the project's structure graph, projected ONCE. Null when GDS is unavailable. */
export async function influenceScores(
  driver: Driver, projectId: string, userIds: string[],
): Promise<{ pageRank: Map<string, number>; betweenness: Map<string, number> } | null> {
  const graphName = GRAPH_NAME_PREFIX + projectId.replace(/-/g, "");
  return withProjectedGdsGraph(driver, graphName, userIds, async (session, g) => {
    const pr = await session.run(
      `CALL gds.pageRank.stream($g) YIELD nodeId, score
       RETURN gds.util.asNode(nodeId).id AS userId, score`, { g });
    const bt = await session.run(
      `CALL gds.betweenness.stream($g) YIELD nodeId, score
       RETURN gds.util.asNode(nodeId).id AS userId, score`, { g });
    return { pageRank: scoresFromRecords(pr.records), betweenness: scoresFromRecords(bt.records) };
  });
}

// ── Per-report computation (builds the stored payload) ───────────────────────

async function computeInfluence(driver: Driver, projectId: string, userIds: string[]): Promise<InfluencePayload | null> {
  const scores = await influenceScores(driver, projectId, userIds);
  if (!scores) return null;
  const { pageRank, betweenness } = scores;
  const row = (userId: string): InfluenceRow => ({
    userId, pageRank: round4(pageRank.get(userId) ?? 0), betweenness: round4(betweenness.get(userId) ?? 0),
  });
  return {
    leaders: topByScore(pageRank, TOP_N).map((e) => row(e.userId)),
    bridges: topByScore(betweenness, TOP_N).map((e) => row(e.userId)),
  };
}

async function computeSilos(driver: Driver, projectId: string, userIds: string[]): Promise<SilosPayload | null> {
  const communities = await louvainCommunities(driver, projectId, userIds);
  if (!communities) return null; // operator silos require GDS Louvain — no by-space fallback (spaces aren't silos)
  const memberSpaces = await fetchMemberSpaces(projectId);
  const silos: SiloRow[] = [...communities.entries()]
    .filter(([, members]) => members.length >= SILO_MIN_SIZE)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([id, members]) => ({ id, size: members.length, memberIds: members, spaces: dominantSpaces(members, memberSpaces) }));
  return { silos };
}

async function computeEngagement(
  driver: Driver, projectId: string, cfg: ResolvedSocialConfig, now: number,
): Promise<EngagementPayload> {
  const sP = personScoresFromPairs(await fetchWarmthPairs(driver, projectId, cfg, now));
  return { members: [...sP.entries()].map(([userId, v]) => ({ userId, sP: round4(v) })) };
}

async function fetchMemberSpaces(projectId: string): Promise<Map<string, string[]>> {
  const rows = await getDb()
    .select({ userId: spaceMembers.userId, spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.projectId, projectId), eq(spaceMembers.status, "active")));
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const arr = m.get(r.userId);
    if (arr) arr.push(r.spaceId);
    else m.set(r.userId, [r.spaceId]);
  }
  return m;
}

// ── Materialization (the weekly cron's work) ─────────────────────────────────

async function buildReport(
  driver: Driver, projectId: string, report: SocialAnalyticsReport, cfg: ResolvedSocialConfig,
  userIds: string[], now: number,
): Promise<{ payload: InfluencePayload | SilosPayload | EngagementPayload; memberCount: number } | null> {
  switch (report) {
    case "influence": {
      const payload = await computeInfluence(driver, projectId, userIds);
      if (!payload) return null;
      const memberCount = new Set([...payload.leaders, ...payload.bridges].map((r) => r.userId)).size;
      return { payload, memberCount };
    }
    case "silos": {
      const payload = await computeSilos(driver, projectId, userIds);
      if (!payload) return null;
      return { payload, memberCount: payload.silos.reduce((s, x) => s + x.size, 0) };
    }
    case "engagement": {
      const payload = await computeEngagement(driver, projectId, cfg, now);
      return { payload, memberCount: payload.members.length };
    }
  }
}

async function reportDue(projectId: string, report: SocialAnalyticsReport, now: number): Promise<boolean> {
  const [last] = await getDb()
    .select({ computedAt: socialAnalytics.computedAt })
    .from(socialAnalytics)
    .where(and(eq(socialAnalytics.projectId, projectId), eq(socialAnalytics.report, report)))
    .orderBy(desc(socialAnalytics.computedAt))
    .limit(1);
  return !last || now - last.computedAt.getTime() >= ANALYTICS_EPOCH_DAYS * DAY_MS;
}

async function materializeProject(
  driver: Driver, projectId: string, now: number, force: boolean, reports: SocialAnalyticsReport[],
): Promise<boolean> {
  const cfg = await getSocialConfig(projectId);
  if (!cfg.graphEnabled) return false;
  const enabled = reports.filter((r) => cfg[ANALYTICS_REPORT_FLAG[r]] === true);
  if (enabled.length === 0) return false;

  const userRows = await getDb().select({ id: profiles.id }).from(profiles).where(eq(profiles.projectId, projectId));
  const userIds = userRows.map((r) => r.id);
  if (userIds.length === 0) return false;

  let any = false;
  for (const report of enabled) {
    if (!force && !(await reportDue(projectId, report, now))) continue;
    const built = await buildReport(driver, projectId, report, cfg, userIds, now);
    if (!built) continue; // e.g. GDS unavailable for influence/silos
    const computedAt = new Date(now);
    await getDb()
      .insert(socialAnalytics)
      .values({ projectId, report, computedAt, payload: built.payload, memberCount: built.memberCount })
      .onConflictDoUpdate({
        target: [socialAnalytics.projectId, socialAnalytics.report, socialAnalytics.computedAt],
        set: { payload: built.payload, memberCount: built.memberCount, updatedAt: computedAt },
      });
    logger.info({ projectId, report, memberCount: built.memberCount }, "social: analytics materialized");
    any = true;
  }
  return any;
}

/** Recompute + snapshot the analytics for one project (or all). Mirrors rollupConstellation: idempotent,
 *  self-healing, a no-op for reports younger than the epoch (unless `force`). No-op (logged) when Neo4j is
 *  unconfigured. `reports` defaults to all three. */
export async function rollupAnalytics(
  projectId?: string | null,
  opts: { driver?: Driver | null; nowMs?: number; force?: boolean; reports?: SocialAnalyticsReport[] } = {},
): Promise<{ projects: number; materialized: number }> {
  const now = opts.nowMs ?? Date.now();
  const driver = opts.driver !== undefined ? opts.driver : getNeo4j();
  if (!driver) {
    logger.warn("social: analytics rollup skipped (neo4j not configured)");
    return { projects: 0, materialized: 0 };
  }
  const reports = opts.reports ?? [...SOCIAL_ANALYTICS_REPORTS];
  const ids = projectId
    ? [projectId]
    : (await getDb().select({ id: projects.id }).from(projects)).map((r) => r.id);

  let materialized = 0;
  for (const id of ids) {
    try {
      if (await materializeProject(driver, id, now, opts.force ?? false, reports)) materialized++;
    } catch (err) {
      if (!isNeo4jError(err)) throw err; // a programmer bug must not masquerade as a skipped project
      logger.warn("social: analytics rollup failed for a project");
      logger.debug({ err, projectId: id }, "social: analytics rollup failed");
    }
  }
  return { projects: ids.length, materialized };
}

// ── Reads (operator endpoints; latest snapshot, names hydrated fresh) ────────

async function latestSnapshot(projectId: string, report: SocialAnalyticsReport) {
  const [row] = await getDb()
    .select()
    .from(socialAnalytics)
    .where(and(eq(socialAnalytics.projectId, projectId), eq(socialAnalytics.report, report)))
    .orderBy(desc(socialAnalytics.computedAt))
    .limit(1);
  return row;
}

export async function getInfluence(projectId: string): Promise<SocialInfluence> {
  const row = await latestSnapshot(projectId, "influence");
  if (!row) return { leaders: [], bridges: [], asOf: null };
  const payload = row.payload as InfluencePayload;
  const names = await fetchProfiles(projectId, [...payload.leaders, ...payload.bridges].map((r) => r.userId));
  const toMember = (r: InfluenceRow): InfluenceMember => {
    const p = names.get(r.userId);
    return {
      userId: r.userId, username: p?.username ?? null, name: p?.name ?? null, avatar: p?.avatar ?? null,
      pageRank: r.pageRank, betweenness: r.betweenness,
    };
  };
  return { leaders: payload.leaders.map(toMember), bridges: payload.bridges.map(toMember), asOf: row.computedAt.toISOString() };
}

export async function getSilos(projectId: string): Promise<SocialSilos> {
  const row = await latestSnapshot(projectId, "silos");
  if (!row) return { silos: [], asOf: null };
  const payload = row.payload as SilosPayload;
  const [names, spaceNames] = await Promise.all([
    fetchProfiles(projectId, payload.silos.flatMap((s) => s.memberIds)),
    fetchSpaceNames(projectId, payload.silos.flatMap((s) => s.spaces.map((sp) => sp.spaceId))),
  ]);
  const silos: Silo[] = payload.silos.map((s) => ({
    id: s.id,
    size: s.size,
    members: s.memberIds.map((id) => {
      const p = names.get(id);
      return { userId: id, username: p?.username ?? null, name: p?.name ?? null, avatar: p?.avatar ?? null };
    }),
    spaces: s.spaces.map((sp) => ({ spaceId: sp.spaceId, name: spaceNames.get(sp.spaceId) ?? null, memberCount: sp.memberCount })),
  }));
  return { silos, asOf: row.computedAt.toISOString() };
}

const RISK_ORDER: Record<ChurnRiskBand, number> = { "at-risk": 0, watch: 1, none: 2 };

export async function getEngagement(projectId: string): Promise<SocialEngagement> {
  const rows = await getDb()
    .select()
    .from(socialAnalytics)
    .where(and(eq(socialAnalytics.projectId, projectId), eq(socialAnalytics.report, "engagement")))
    .orderBy(desc(socialAnalytics.computedAt))
    .limit(ENGAGEMENT_TREND_WINDOW);
  if (rows.length === 0) return { members: [], asOf: null };

  const latest = rows[0]!;
  const chrono = [...rows].reverse(); // oldest→newest for the trend series
  const series = new Map<string, number[]>();
  for (const snap of chrono) {
    for (const m of (snap.payload as EngagementPayload).members) {
      const arr = series.get(m.userId);
      if (arr) arr.push(m.sP);
      else series.set(m.userId, [m.sP]);
    }
  }

  const latestMembers = (latest.payload as EngagementPayload).members;
  const names = await fetchProfiles(projectId, latestMembers.map((m) => m.userId));
  const members: EngagementMember[] = latestMembers.map((m) => {
    const trend = series.get(m.userId) ?? [m.sP];
    const { delta, churnRisk } = churnFromSeries(trend);
    const p = names.get(m.userId);
    return {
      userId: m.userId, username: p?.username ?? null, name: p?.name ?? null, avatar: p?.avatar ?? null,
      sP: m.sP, trend, delta, churnRisk,
    };
  });
  members.sort((a, b) => RISK_ORDER[a.churnRisk] - RISK_ORDER[b.churnRisk] || a.sP - b.sP);
  return { members, asOf: latest.computedAt.toISOString() };
}

async function fetchSpaceNames(projectId: string, spaceIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const uniq = [...new Set(spaceIds)];
  if (uniq.length === 0) return map;
  const rows = await getDb()
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(and(eq(spaces.projectId, projectId), inArray(spaces.id, uniq)));
  for (const r of rows) map.set(r.id, r.name);
  return map;
}
