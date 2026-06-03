// Cron-able community-activity rollup. Standalone — connects via DATABASE_URL (lib/community-stats
// imports the Drizzle db) and (re)computes the trailing window of hourly buckets into
// community_stats_hourly; the Agora server need not be running. Run from apps/api/ via tsx (resolves
// the .js import to the TS source):
//   npx tsx scripts/rollup-community-stats.mjs                 # all projects
//   npx tsx scripts/rollup-community-stats.mjs --project <id>  # scope to one project
// Until there's a host: drive this from local cron/launchd hourly. Once deployed, an external
// scheduler can instead hit POST /internal/cron/community-stats (X-Cron-Secret) — same work, no tsx.
import { rollupCommunityStats } from "../src/lib/community-stats.js";

const argv = process.argv.slice(2);
const i = argv.indexOf("--project");
const projectId = i !== -1 ? argv[i + 1] : undefined;

const res = await rollupCommunityStats(projectId);
console.log(`✓ community stats: ${res.hours} hour-bucket(s) rolled up across ${res.projects} project(s)`);
process.exit(0);
