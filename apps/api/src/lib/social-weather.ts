// Community Weather — the read side of the warmth math (docs/AGORA-SOCIAL.md §11, SOCIAL-GRAPH.md §3).
// Cypher returns raw per-ordered-pair decayed sums {actor, recipient, w, f}; everything formula-shaped
// (cap+floor brightness, S_p, banding with hysteresis) lives here as pure functions so it unit-tests
// without a graph. Decision log (PR 3): the friction term F is now ADDITIVE — negative Layer-1
// sentiment (angry/downvote reactions) AND dedicated Layer-2 FRICTION edges (user reports, migration
// 0039) both feed F, summed per directed pair. An age cutoff (AGE_CUTOFF_HALF_LIVES warmth half-lives)
// drops long-dead edges so a dormant community reads "quiet", not "stormy". Per-space Weather is still
// deferred (spaceId isn't in the graph yet).
import type { Driver } from "neo4j-driver";
import type { ResolvedSocialConfig, SocialWeather, WeatherBand } from "@agora-server/contract";
import { getNeo4j } from "./neo4j.js";

// Design constants — locked by docs/AGORA-SOCIAL.md §11; deliberately NOT in social_config.
export const K_W = 10;       // warmth saturation constant
export const C_F = 0.5;      // CAP: friction can remove at most half the warmth term
export const B_FLOOR = 0.15; // FLOOR: extra-dark-equals-friction is unreadable by construction

const HYSTERESIS_MARGIN = 0.02; // band moves only on a margin-crossing change (§12)
// An edge whose `at` is older than this many WARMTH half-lives (≈6·30d = 180d) is dropped from the
// scan: by then its decayed contribution is ~2⁻⁶ ≈ 1.5% and a fully dormant project would otherwise
// asymptote to floor-dark "stormy" instead of dropping out as "quiet" (SOCIAL-GRAPH.md §7). Also
// shrinks the scan. Uses the longer (warmth) half-life so friction never outlives the warmth it dims.
export const AGE_CUTOFF_HALF_LIVES = 6;

const LN2 = Math.LN2;
const DAY_MS = 86_400_000;
const TREND_WINDOW_MS = 7 * DAY_MS;   // trend = now vs. as-of-7-days-ago
const WEATHER_TTL_MS = 3_600_000;     // recompute at most hourly per project

export interface WarmthPair {
  actor: string;
  recipient: string;
  w: number; // decayed positive-sentiment sum, ≥ 0
  f: number; // decayed negative-sentiment magnitude sum, ≥ 0
}

/** Dyadic brightness B(u,v) with the CAP + FLOOR guarantees. */
export function pairBrightness(w: number, f: number): number {
  const sw = w / (w + K_W);
  const phi = f / (f + w + K_W);
  return B_FLOOR + (1 - B_FLOOR) * sw * (1 - C_F * phi);
}

/** Weather = mean over persons of S_p, where S_p = mean INBOUND brightness. Null when no pairs.
 *  Persons with no inbound pair (actors only) don't contribute an S_p — no data, no entry. Inputs
 *  are assumed clean (w, f ≥ 0 from the Cypher sums); garbage degrades to "stormy", never throws. */
export function weatherFromPairs(pairs: WarmthPair[]): number | null {
  if (pairs.length === 0) return null;
  const inbound = new Map<string, { sum: number; n: number }>();
  for (const p of pairs) {
    const acc = inbound.get(p.recipient) ?? { sum: 0, n: 0 };
    acc.sum += pairBrightness(p.w, p.f);
    acc.n += 1;
    inbound.set(p.recipient, acc);
  }
  let total = 0;
  for (const acc of inbound.values()) total += acc.sum / acc.n;
  return total / inbound.size;
}

const BAND_BOUNDS = [0.35, 0.55, 0.75] as const;
const BAND_SCALE: readonly WeatherBand[] = ["stormy", "overcast", "fine", "sunny"];

/** Bucket a weather value, holding the previous band inside HYSTERESIS_MARGIN of a boundary so the
 *  published label only moves on a persistent, margin-crossing change (docs/AGORA-SOCIAL.md §12). */
export function weatherBand(value: number | null, prevBand?: WeatherBand): WeatherBand {
  if (value == null) return "quiet";
  let idx = BAND_BOUNDS.filter((b) => value >= b).length;
  if (prevBand && prevBand !== "quiet") {
    const prevIdx = BAND_SCALE.indexOf(prevBand);
    if (Math.abs(idx - prevIdx) === 1) {
      const boundaryIdx = Math.min(idx, prevIdx) as 0 | 1 | 2;
      const boundary = BAND_BOUNDS[boundaryIdx];
      if (Math.abs(value - boundary) < HYSTERESIS_MARGIN) idx = prevIdx;
    }
  }
  // idx is 0-3 by construction (filter length on a 3-element array → 0..3)
  return BAND_SCALE[idx] as WeatherBand;
}

// Per-ordered-pair decayed sums. Decay is READ-TIME (edges are never rewritten): each edge contributes
// magnitude · exp(−ln2 · ageDays / halfLife). `at` is epoch-ms (scorer timestamp()). Two branches,
// UNION ALL'd (a pair may appear in BOTH — mergePairRows sums them downstream):
//   • INTERACTED — positive sentiment → w (warmth half-life), negative → f (friction half-life). Zero
//     sentiment is excluded on purpose: the scorer writes 0 for deliberately-neutral reactions
//     ("sad" = empathy) — without the filter such a pair would sum to w=0,f=0 and read as a floor-dark
//     datapoint, inverting the design's intent (no signal ⇒ no entry).
//   • FRICTION — dedicated report edges (migration 0039), f only, decayed at the friction half-life,
//     weight read from the edge (the scorer's constant). This is the ADDITIVE half of the fold: a pair
//     with both a hostile reaction and a report dims by the sum of the two.
// Both branches drop edges older than $ageCutoff (see AGE_CUTOFF_HALF_LIVES). Perf: projectId scoping
// rides the scorer indexes (scorer_interacted_project / scorer_friction_project); the query runs ≤2×
// per project per WEATHER_TTL_MS. TODO: fold both trend windows into one query.
export const WEATHER_PAIRS_CYPHER = `
MATCH (a:User)-[r:INTERACTED]->(b:User)
WHERE r.projectId = $projectId AND r.at <= $asOf AND r.at >= $ageCutoff AND a.id <> b.id
  AND r.sentiment IS NOT NULL AND r.sentiment <> 0
WITH a.id AS actor, b.id AS recipient,
     sum(CASE WHEN r.sentiment > 0
          THEN r.sentiment * exp(-${LN2} * (toFloat($asOf - r.at) / ${DAY_MS}.0) / toFloat($warmthHalfLifeDays))
          ELSE 0.0 END) AS w,
     sum(CASE WHEN r.sentiment < 0
          THEN -r.sentiment * exp(-${LN2} * (toFloat($asOf - r.at) / ${DAY_MS}.0) / toFloat($frictionHalfLifeDays))
          ELSE 0.0 END) AS f
RETURN actor, recipient, w, f
UNION ALL
MATCH (a:User)-[r:FRICTION]->(b:User)
WHERE r.projectId = $projectId AND r.at <= $asOf AND r.at >= $ageCutoff AND a.id <> b.id
WITH a.id AS actor, b.id AS recipient,
     0.0 AS w,
     sum(coalesce(r.weight, 1.0) * exp(-${LN2} * (toFloat($asOf - r.at) / ${DAY_MS}.0) / toFloat($frictionHalfLifeDays))) AS f
RETURN actor, recipient, w, f`;

// neo4j-driver may hand back Integer objects for whole numbers; sums here are floats but stay defensive.
const toNum = (v: unknown): number =>
  typeof v === "number" ? v : ((v as { toNumber?: () => number })?.toNumber?.() ?? 0);

/** Collapse the UNION ALL rows by directed pair: the INTERACTED and FRICTION branches can each emit a
 *  row for the SAME (actor, recipient), so their w/f must be summed into ONE pair before brightness —
 *  otherwise the friction row reads as a separate floor-dark datapoint instead of dimming the warm tie
 *  (the additive-fold correctness point, docs/AGORA-SOCIAL.md §11). UUID endpoints never contain '|'. */
export function mergePairRows(rows: WarmthPair[]): WarmthPair[] {
  const merged = new Map<string, WarmthPair>();
  for (const row of rows) {
    const key = `${row.actor}|${row.recipient}`;
    const acc = merged.get(key);
    if (acc) {
      acc.w += row.w;
      acc.f += row.f;
    } else {
      merged.set(key, { actor: row.actor, recipient: row.recipient, w: row.w, f: row.f });
    }
  }
  return [...merged.values()];
}

type HalfLives = Pick<ResolvedSocialConfig, "warmthHalfLifeDays" | "frictionHalfLifeDays">;

/** One window: raw (unrounded) weather as of `asOfMs`, or null when the graph is empty. */
export async function computeWeather(
  driver: Driver, projectId: string, cfg: HalfLives, asOfMs: number,
): Promise<number | null> {
  // Edges older than this fall out of the scan (dormant ⇒ "quiet", not floor-dark "stormy").
  const ageCutoff = asOfMs - AGE_CUTOFF_HALF_LIVES * cfg.warmthHalfLifeDays * DAY_MS;
  const { records } = await driver.executeQuery(WEATHER_PAIRS_CYPHER, {
    projectId,
    asOf: asOfMs,
    ageCutoff,
    warmthHalfLifeDays: cfg.warmthHalfLifeDays,
    frictionHalfLifeDays: cfg.frictionHalfLifeDays,
  });
  const rows: WarmthPair[] = (records as Array<{ get: (k: string) => unknown }>).map((r) => ({
    actor: String(r.get("actor")),
    recipient: String(r.get("recipient")),
    w: toNum(r.get("w")),
    f: toNum(r.get("f")),
  }));
  return weatherFromPairs(mergePairRows(rows));
}

// Stale entries are kept past the TTL on purpose: the previous band anchors hysteresis.
const weatherCache = new Map<string, { payload: SocialWeather; at: number }>();

/** The member-facing Weather payload, cached per project for WEATHER_TTL_MS. Trend is dual-window
 *  (now vs. now − 7d) so no history table is needed. Throws when Neo4j is unconfigured/unreachable —
 *  the route maps that to 503. `opts` exists for tests (stub driver, frozen clock). */
export async function getSocialWeather(
  projectId: string, cfg: HalfLives, opts: { driver?: Driver; nowMs?: number } = {},
): Promise<SocialWeather> {
  const now = opts.nowMs ?? Date.now();
  const hit = weatherCache.get(projectId);
  if (hit && now - hit.at < WEATHER_TTL_MS) return hit.payload;
  const driver = opts.driver ?? getNeo4j();
  if (!driver) throw new Error("neo4j read client is not configured");
  const [current, prior] = await Promise.all([
    computeWeather(driver, projectId, cfg, now),
    computeWeather(driver, projectId, cfg, now - TREND_WINDOW_MS),
  ]);
  const value = current == null ? null : Math.round(current * 100) / 100;
  const payload: SocialWeather = Object.freeze({
    value,
    band: weatherBand(value, hit?.payload.band),
    trend: current == null || prior == null ? null : Math.round((current - prior) * 1000) / 1000,
    asOf: new Date(now).toISOString(),
  });
  weatherCache.set(projectId, { payload, at: now });
  return payload;
}

/** Drop a project's cached Weather (call after an admin PATCHes /settings/social — half-life or
 *  enablement changes should be visible promptly, not an hour later). Per-replica, like the config
 *  caches: with multiple API replicas the others serve the old value until their TTL lapses. */
export function invalidateSocialWeather(projectId: string): void {
  weatherCache.delete(projectId);
}
