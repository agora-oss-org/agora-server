// Cron-able batch score recompute, feed_config-aware. For each project: stored-mode `decay` defaults
// snapshot entities.score to the evaluated half-life value (recompute_decay_scores); everyone else
// re-syncs the time-anchored hot_score (recompute_scores). Run from server/ with DATABASE_URL set.
//   node scripts/recompute-scores.mjs                 # all projects
//   node scripts/recompute-scores.mjs --project <id>  # one project
// (The same work runs via POST /internal/cron/recompute-scores when CRON_SECRET is set.)
import "dotenv/config";
import postgres from "postgres";

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("DATABASE_URL required"); process.exit(1); }
const i = process.argv.indexOf("--project");
const only = i !== -1 ? process.argv[i + 1] : null;

const DEFAULT_WEIGHTS = { upvote: 1, like: 1, love: 2, wow: 1, funny: 1, sad: 0, angry: 0, downvote: 1 };
const sql = postgres(DB, { prepare: false, onnotice() {} });
try {
  const rows = only
    ? await sql`select id, feed_config from projects where id = ${only}::uuid`
    : await sql`select id, feed_config from projects`;
  let updated = 0;
  for (const { id, feed_config } of rows) {
    const cfg = feed_config && typeof feed_config === "object" ? feed_config : {};
    if (cfg.defaultAlgorithm === "decay" && cfg.decayMode === "stored") {
      const halfLife = Number.isFinite(Number(cfg.halfLifeHours)) ? Number(cfg.halfLifeHours) : 24;
      const weights = { ...DEFAULT_WEIGHTS, ...(cfg.reactionWeights ?? {}) };
      const [{ n }] = await sql`select recompute_decay_scores(${id}::uuid, ${halfLife}::double precision, ${JSON.stringify(weights)}::jsonb) as n`;
      updated += Number(n ?? 0);
    } else {
      const [{ n }] = await sql`select recompute_scores(${id}::uuid) as n`;
      updated += Number(n ?? 0);
    }
  }
  console.log(`✓ recomputed ${updated} entity score(s) across ${rows.length} project(s)`);
} finally {
  await sql.end();
}
process.exit(0);
