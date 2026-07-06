// Per-project social-graph config, resolved from projects.social_config JSONB with a 30s cache +
// invalidate — mirrors lib/steward-config.ts. Resolution/clamping is the contract's pure
// resolveSocialConfig (fail-closed → community defaults). See docs/SOCIAL-GRAPH.md §5.
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/index.js";
import { resolveSocialConfig, type ResolvedSocialConfig } from "@agora-server/contract";

const CONFIG_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedSocialConfig; at: number }>();

export async function getSocialConfig(projectId: string): Promise<ResolvedSocialConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
  const [p] = await getDb()
    .select({ socialConfig: projects.socialConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const cfg = resolveSocialConfig(p?.socialConfig);
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}

/** Drop the cached config (call after an admin PATCHes /settings/social). */
export function invalidateSocialConfig(projectId: string): void {
  cache.delete(projectId);
}

/** Admin GET view: the raw stored overrides + the effective (resolved, clamped) config. */
export function socialConfigView(stored: unknown, effective: ResolvedSocialConfig) {
  const s = (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  return { stored: s, effective };
}

/** Member-facing transparency view (docs/AGORA-CORP.md §4.5): the active tier + every enabled
 *  analytic, readable by any authenticated member. Members always know which instrument their
 *  instance is. */
export function transparencyView(cfg: ResolvedSocialConfig) {
  return {
    privacyTier: cfg.privacyTier,
    analytics: {
      influenceScores: cfg.influenceScoresEnabled,
      siloDetection: cfg.siloDetectionEnabled,
      engagementScores: cfg.engagementScoresEnabled,
      frictionAnalytics: cfg.frictionAnalyticsEnabled,
      readReceiptsAllowed: cfg.readReceiptsAllowed,
    },
    garden: {
      graph: cfg.graphEnabled,
      weather: cfg.weatherEnabled,
      constellation: cfg.constellationEnabled,
      neighborhood: cfg.neighborhoodEnabled,
      readAffinity: cfg.readAffinityEnabled,
    },
    decay: { warmthHalfLifeDays: cfg.warmthHalfLifeDays, frictionHalfLifeDays: cfg.frictionHalfLifeDays },
  };
}
