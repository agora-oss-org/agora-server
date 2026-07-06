// Per-project feed ranking config: the resolved shape (defaults merged over the stored
// projects.feed_config JSONB), with a 30s cache + invalidate — mirrors lib/webhooks.ts:getConfig.
// All numeric tunables are coerced to finite numbers here; range-clamping is enforced at write time
// by feedConfigSchema (PATCH /settings/feed). Unknown algorithm names fall back to "hot".
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/index.js";
import { DEFAULT_RANK_PARAMS, DEFAULT_WEIGHTS, KNOWN_ALGORITHMS, type RankParams } from "./ranking.js";

export interface RerankWebhookConfig { url: string; secret: string; timeoutMs: number; overFetch: number; }
export interface ResolvedFeedConfig {
  defaultAlgorithm: string;            // used when the request omits sortBy
  decayMode: "stored" | "query-time";  // stored = cron-snapshotted score; query-time = live (default)
  params: RankParams;                  // base tunables (request rankParams overrides these)
  weights: Record<string, number>;     // reaction weights for net-vote algos
  diversity: { perAuthorCap: number } | null;
  rerankWebhook: RerankWebhookConfig | null;
}

const CONFIG_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedFeedConfig; at: number }>();

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

function resolve(raw: unknown): ResolvedFeedConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const params: RankParams = {
    halfLifeHours: num(r.halfLifeHours, DEFAULT_RANK_PARAMS.halfLifeHours),
    gravity: num(r.gravity, DEFAULT_RANK_PARAMS.gravity),
    z: num(r.z, DEFAULT_RANK_PARAMS.z),
    C: num(r.C, DEFAULT_RANK_PARAMS.C),
    m: num(r.m, DEFAULT_RANK_PARAMS.m),
  };
  const weights = { ...DEFAULT_WEIGHTS };
  if (r.reactionWeights && typeof r.reactionWeights === "object") {
    for (const [k, v] of Object.entries(r.reactionWeights)) {
      if (k in weights && Number.isFinite(Number(v))) weights[k] = Number(v);
    }
  }
  const rw = r.rerankWebhook;
  const rerankWebhook = rw && typeof rw === "object" && typeof rw.url === "string" && typeof rw.secret === "string"
    ? { url: rw.url, secret: rw.secret, timeoutMs: num(rw.timeoutMs, 4000), overFetch: num(rw.overFetch, 3) }
    : null;
  return {
    defaultAlgorithm: typeof r.defaultAlgorithm === "string" && KNOWN_ALGORITHMS.includes(r.defaultAlgorithm) ? r.defaultAlgorithm : "hot",
    decayMode: r.decayMode === "stored" ? "stored" : "query-time",
    params,
    weights,
    diversity: r.diversity && Number.isFinite(Number(r.diversity.perAuthorCap)) ? { perAuthorCap: Number(r.diversity.perAuthorCap) } : null,
    rerankWebhook,
  };
}

export async function getFeedConfig(projectId: string): Promise<ResolvedFeedConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
  const [p] = await getDb().select({ feedConfig: projects.feedConfig }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const cfg = resolve(p?.feedConfig);
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}

/** Drop the cached config (call after an admin PATCHes /settings/feed). */
export function invalidateFeedConfig(projectId: string): void { cache.delete(projectId); }

/** Safe view for the admin GET — never returns the re-rank webhook secret. */
export function feedConfigView(cfg: ResolvedFeedConfig) {
  return {
    ...cfg,
    rerankWebhook: cfg.rerankWebhook
      ? { url: cfg.rerankWebhook.url, timeoutMs: cfg.rerankWebhook.timeoutMs, overFetch: cfg.rerankWebhook.overFetch, hasSecret: true }
      : null,
  };
}
