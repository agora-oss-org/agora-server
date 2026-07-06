// Per-project steward (conflict-resolution) config, resolved from projects.steward_config JSONB with a
// 30s cache + invalidate — mirrors lib/feed-config.ts. Holds the notification policy (who gets told about
// a case — see lib/notifications.ts stewardCaseRecipients) plus the mediation policy (how channels are run
// + wound down — see lib/mediation.ts). Defaults: privacy-of-the-harmed "power-aware" notifications,
// "hybrid" mediation (caucus + optional consensual joint room), and archive-read-only channel wind-down.
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/index.js";
import {
  STEWARD_NOTIFY_POLICIES, STEWARD_MEDIATION_MODES, STEWARD_MEDIATION_ON_CLOSE,
  type StewardNotifyPolicy, type StewardMediationMode, type StewardMediationOnClose, type StewardConfigView,
} from "@agora-server/contract";

export interface ResolvedStewardConfig {
  notifyPolicy: StewardNotifyPolicy;
  mediationMode: StewardMediationMode;
  mediationOnClose: StewardMediationOnClose;
}

const DEFAULT_POLICY: StewardNotifyPolicy = "power-aware";
const DEFAULT_MEDIATION_MODE: StewardMediationMode = "hybrid";
const DEFAULT_MEDIATION_ON_CLOSE: StewardMediationOnClose = "archive-read-only";
const CONFIG_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedStewardConfig; at: number }>();

function resolve(raw: unknown): ResolvedStewardConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = r.notifyPolicy;
  const m = r.mediationMode;
  const oc = r.mediationOnClose;
  return {
    notifyPolicy: STEWARD_NOTIFY_POLICIES.includes(p as StewardNotifyPolicy) ? (p as StewardNotifyPolicy) : DEFAULT_POLICY,
    mediationMode: STEWARD_MEDIATION_MODES.includes(m as StewardMediationMode) ? (m as StewardMediationMode) : DEFAULT_MEDIATION_MODE,
    mediationOnClose: STEWARD_MEDIATION_ON_CLOSE.includes(oc as StewardMediationOnClose) ? (oc as StewardMediationOnClose) : DEFAULT_MEDIATION_ON_CLOSE,
  };
}

export async function getStewardConfig(projectId: string): Promise<ResolvedStewardConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
  const [p] = await getDb().select({ stewardConfig: projects.stewardConfig }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const cfg = resolve(p?.stewardConfig);
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}

/** Drop the cached config (call after an admin PATCHes /settings/steward). */
export function invalidateStewardConfig(projectId: string): void { cache.delete(projectId); }

/** Safe view for the admin GET. */
export function stewardConfigView(cfg: ResolvedStewardConfig): StewardConfigView {
  return { notifyPolicy: cfg.notifyPolicy, mediationMode: cfg.mediationMode, mediationOnClose: cfg.mediationOnClose };
}
