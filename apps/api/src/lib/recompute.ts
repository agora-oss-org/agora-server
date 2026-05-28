// Batch score recompute, feed_config-aware. Projects whose default algorithm is stored-mode `decay`
// get their entities.score snapshotted to the evaluated half-life value (recompute_decay_scores);
// everyone else keeps the time-anchored hot_score (recompute_scores). Decoupled work fn (mirrors
// lib/digests.ts:sendDueDigests) — invoked by POST /internal/cron/recompute-scores + the standalone
// scripts/recompute-scores.mjs.
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema/index.js";
import { getFeedConfig } from "./feed-config.js";

export async function recomputeDueScores(projectId?: string | null): Promise<{ projects: number; updated: number }> {
  const ids = projectId
    ? [projectId]
    : (await db.select({ id: projects.id }).from(projects)).map((r) => r.id);

  let updated = 0;
  for (const id of ids) {
    const cfg = await getFeedConfig(id);
    const rows =
      cfg.defaultAlgorithm === "decay" && cfg.decayMode === "stored"
        ? await db.execute(sql`select recompute_decay_scores(${id}::uuid, ${cfg.params.halfLifeHours}::double precision, ${JSON.stringify(cfg.weights)}::jsonb) as n`)
        : await db.execute(sql`select recompute_scores(${id}::uuid) as n`);
    updated += Number((rows as any)[0]?.n ?? 0);
  }
  return { projects: ids.length, updated };
}
