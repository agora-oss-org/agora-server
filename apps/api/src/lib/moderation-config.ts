// Per-project moderation config: how content moderated as "removed" is served to non-moderators.
// Resolved shape (defaults merged over the stored projects.moderation_config JSONB) + 30s cache +
// invalidate — mirrors lib/feed-config.ts.
//
//   - "hide"        → removed entities/comments are filtered out of lists/feeds/threads and 404 on
//                     single reads (the default — closest to "gone").
//   - "placeholder" → the row stays but its content is blanked, so clients render a "[removed]"
//                     stub (preserves reply chains + counts, Reddit-style).
//
// Operators always bypass (they review removed content via the admin queue) — see lib/moderation-
// visibility.ts for the read-path enforcement that consumes this config.
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema/index.js";

export type RemovedContentBehavior = "hide" | "placeholder";
export interface ResolvedModerationConfig {
  removedContentBehavior: RemovedContentBehavior;
}

const CONFIG_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedModerationConfig; at: number }>();

function resolve(raw: unknown): ResolvedModerationConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  return { removedContentBehavior: r.removedContentBehavior === "placeholder" ? "placeholder" : "hide" };
}

export async function getModerationConfig(projectId: string): Promise<ResolvedModerationConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
  const [p] = await db
    .select({ moderationConfig: projects.moderationConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const cfg = resolve(p?.moderationConfig);
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}

/** Drop the cached config (call after an admin PATCHes /settings/moderation). */
export function invalidateModerationConfig(projectId: string): void {
  cache.delete(projectId);
}

/** View for the admin GET (currently a 1:1 echo; kept for symmetry with feedConfigView). */
export function moderationConfigView(cfg: ResolvedModerationConfig) {
  return { ...cfg };
}
