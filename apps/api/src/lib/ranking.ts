// Closed registry of feed ranking algorithms. Each algorithm is a builder that emits Drizzle `sql`
// ORDER BY expressions; every interpolated tunable (half-life, gravity, weights, …) is a *numeric*
// value that has been validated + range-clamped (see `rankParamsSchema` / `feedConfigSchema`), so no
// algorithm name, formula, or weight is ever injected as SQL text. Algorithm names are a fixed enum.
//
// Two storage classes:
//   "stored"     → orders by the denormalized entities.score column (index-served; refreshed on vote
//                  for `hot`/`top`, or snapshotted by the recompute cron for stored-mode `decay`).
//   "query-time" → emits a live ORDER BY expression evaluated against `anchor` (now() by default, or a
//                  pinned rankAnchor for stable pagination). Accurate but not served by the score index.
import { asc, desc, sql, type SQL } from "drizzle-orm";
import { entities } from "../db/schema/index.js";
import { REACTION_TYPES } from "./shape.js";
import { rankParamsSchema } from "./validation.js";

export type Dir = typeof asc | typeof desc;

// Default reaction weights mirror the original hot_score net: upvote/like/wow/funny=1, love=2,
// downvote subtracted, sad/angry ignored. Overridable per-project via feed_config.reactionWeights.
export const DEFAULT_WEIGHTS: Record<string, number> = {
  upvote: 1, like: 1, love: 2, wow: 1, funny: 1, sad: 0, angry: 0, downvote: 1,
};

export interface RankParams {
  halfLifeHours: number; // `decay`
  gravity: number;       // `gravity` (HN exponent)
  z: number;             // `wilson` z-score
  C: number;             // `bayesian` prior weight
  m: number;             // `bayesian` prior mean
}
export const DEFAULT_RANK_PARAMS: RankParams = { halfLifeHours: 24, gravity: 1.8, z: 1.96, C: 10, m: 0.5 };

const LN2 = Math.LN2;

/** Reaction count as int (0 when absent). */
const rc = (k: string): SQL => sql`coalesce((${entities.reactionCounts}->>${k})::int, 0)`;

/** Weighted net vote: Σ wₖ·countₖ − w_downvote·downvote. Weights are numeric (validated upstream). */
function netExpr(weights: Record<string, number>): SQL {
  const terms: SQL[] = [];
  for (const k of REACTION_TYPES) {
    const w = weights[k] ?? 0;
    if (!w) continue;
    const signed = k === "downvote" ? -w : w;
    terms.push(sql`(${signed})::double precision * ${rc(k)}`);
  }
  return terms.length ? sql`(${sql.join(terms, sql` + `)})` : sql`0::double precision`;
}

/** Age in hours between the ranking anchor and the row's creation, floored at 0. */
const ageHours = (anchor: SQL): SQL =>
  sql`greatest(extract(epoch from (${anchor} - ${entities.createdAt})) / 3600.0, 0)`;

export interface RankCtx {
  params: RankParams;
  weights: Record<string, number>;
  anchor: SQL; // now() or a pinned rankAnchor
  dir: Dir;    // primary sort direction (default desc)
}

export interface RankingAlgo {
  storage: "stored" | "query-time";
  /** Full ORDER BY list, including deterministic tiebreakers (createdAt, id). */
  order: (ctx: RankCtx) => SQL[];
}

const TIE = [desc(entities.createdAt), desc(entities.id)] as const;

export const RANKING_ALGORITHMS: Record<string, RankingAlgo> = {
  // Reddit-style time-anchored score (existing hot_score), denormalized + index-served — recency
  // and votes combined.
  hot: { storage: "stored", order: ({ dir }) => [dir(entities.score), ...TIE] },

  // Pure vote ranking, NO time term (so it differs from `hot`); pair with a `timeFrame` filter for
  // "top this week/month". Ranks by the weighted net vote.
  top: { storage: "query-time", order: ({ weights, dir }) => [dir(netExpr(weights)), ...TIE] },

  new: { storage: "query-time", order: ({ dir }) => [dir(entities.createdAt), desc(entities.id)] },

  controversial: {
    storage: "query-time",
    order: ({ dir }) => [
      dir(sql`least(${rc("upvote")}, ${rc("downvote")})`),
      desc(sql`${rc("upvote")} + ${rc("downvote")}`),
      desc(entities.id),
    ],
  },

  // True exponential half-life: quality − ln2·ageHours/halfLife (order-equivalent to quality·0.5^(age/H)).
  decay: {
    storage: "query-time",
    order: ({ params, weights, anchor, dir }) => {
      const net = netExpr(weights);
      const expr = sql`sign(${net}) * log(greatest(abs(${net}), 1)) - ${LN2} * ${ageHours(anchor)} / ${params.halfLifeHours}`;
      return [dir(expr), ...TIE];
    },
  },

  // Hacker News gravity: (net − 1) / (ageHours + 2)^G.
  gravity: {
    storage: "query-time",
    order: ({ params, weights, anchor, dir }) => {
      const net = netExpr(weights);
      const expr = sql`(${net} - 1) / power(${ageHours(anchor)} + 2, ${params.gravity})`;
      return [dir(expr), ...TIE];
    },
  },

  // Wilson lower bound on the positive fraction up/(up+down); quality-by-confidence, not recency.
  wilson: {
    storage: "query-time",
    order: ({ params, dir }) => {
      const up = rc("upvote"), down = rc("downvote");
      const n = sql`(${up} + ${down})::double precision`;
      const z2 = params.z * params.z;
      const phat = sql`(${up}::double precision / ${n})`;
      const expr = sql`case when ${up} + ${down} = 0 then 0 else
        (${phat} + ${z2} / (2 * ${n}) - ${params.z} * sqrt((${phat} * (1 - ${phat}) + ${z2} / (4 * ${n})) / ${n}))
        / (1 + ${z2} / ${n}) end`;
      return [dir(expr), ...TIE];
    },
  },

  // Bayesian shrunk mean: (C·m + up) / (C + up + down) — damps low-volume items toward prior m.
  bayesian: {
    storage: "query-time",
    order: ({ params, dir }) => {
      const up = rc("upvote"), down = rc("downvote");
      // Cast the bound params to double precision so `C * m` isn't ambiguous `unknown * unknown`.
      const expr = sql`(${params.C}::double precision * ${params.m}::double precision + ${up}) / (${params.C}::double precision + ${up} + ${down})`;
      return [dir(expr), ...TIE];
    },
  },
};

export const KNOWN_ALGORITHMS = Object.keys(RANKING_ALGORITHMS);

/** Parse + clamp the per-request rankParams JSON scalar, merged over the given defaults. */
export function parseRankParams(raw: string | undefined | null, defaults: RankParams): RankParams {
  if (!raw) return defaults;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return defaults; }
  const parsed = rankParamsSchema.safeParse(obj);
  if (!parsed.success) return defaults;
  return { ...defaults, ...parsed.data };
}
