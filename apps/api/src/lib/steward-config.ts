// Per-project steward (conflict-resolution) config, resolved from projects.steward_config JSONB with a
// 30s cache + invalidate — mirrors lib/feed-config.ts. Currently just the notification policy, which
// decides who gets told about a case (see lib/notifications.ts stewardCaseRecipients). Default is the
// privacy-of-the-harmed "power-aware" policy.
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema/index.js";
import { STEWARD_NOTIFY_POLICIES, type StewardNotifyPolicy, type StewardConfigView } from "@agora/contract";

export interface ResolvedStewardConfig {
  notifyPolicy: StewardNotifyPolicy;
}

const DEFAULT_POLICY: StewardNotifyPolicy = "power-aware";
const CONFIG_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedStewardConfig; at: number }>();

function resolve(raw: unknown): ResolvedStewardConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = r.notifyPolicy;
  const notifyPolicy = STEWARD_NOTIFY_POLICIES.includes(p as StewardNotifyPolicy) ? (p as StewardNotifyPolicy) : DEFAULT_POLICY;
  return { notifyPolicy };
}

export async function getStewardConfig(projectId: string): Promise<ResolvedStewardConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
  const [p] = await db.select({ stewardConfig: projects.stewardConfig }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const cfg = resolve(p?.stewardConfig);
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}

/** Drop the cached config (call after an admin PATCHes /settings/steward). */
export function invalidateStewardConfig(projectId: string): void { cache.delete(projectId); }

/** Safe view for the admin GET. */
export function stewardConfigView(cfg: ResolvedStewardConfig): StewardConfigView {
  return { notifyPolicy: cfg.notifyPolicy };
}
