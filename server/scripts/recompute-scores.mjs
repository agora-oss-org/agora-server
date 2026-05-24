// Cron-able batch score recompute. Re-syncs entities.score to current reaction_counts via the
// recompute_scores() SQL function (consistency/backfill — hot_score is time-anchored to created_at,
// not time-decaying). Run from server/ with DATABASE_URL in env. Optional --project <uuid> to scope.
//   node scripts/recompute-scores.mjs                 # all projects
//   node scripts/recompute-scores.mjs --project <id>  # one project
import postgres from "postgres";

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("DATABASE_URL required"); process.exit(1); }
const i = process.argv.indexOf("--project");
const project = i !== -1 ? process.argv[i + 1] : null;

const sql = postgres(DB, { prepare: false, onnotice() {} });
try {
  const [{ recompute_scores: n }] = await sql`select recompute_scores(${project}::uuid)`;
  console.log(`✓ recomputed ${n} entity score(s)${project ? ` for project ${project}` : " (all projects)"}`);
} finally {
  await sql.end();
}
process.exit(0);
