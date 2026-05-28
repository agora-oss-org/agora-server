// Cron-able space-digest sender. Standalone — connects via DATABASE_URL (lib/digests imports the
// Drizzle db) and POSTs each due space an HMAC-signed `space.digest`; the Agora server need not be
// running. Run from server/ via tsx (resolves the .js import to the TS source):
//   npx tsx scripts/send-digests.mjs                 # due-now sweep, all projects
//   npx tsx scripts/send-digests.mjs --force         # ignore the schedule hour (send all enabled)
//   npx tsx scripts/send-digests.mjs --project <id>  # scope to one project
//   npx tsx scripts/send-digests.mjs --space <id>    # scope to one space
// Until there's a host: drive this from local cron/launchd hourly. Once deployed, an external
// scheduler can instead hit POST /internal/cron/digests (X-Cron-Secret) — same work, no tsx.
import { sendDueDigests } from "../src/lib/digests.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const res = await sendDueDigests({
  force: argv.includes("--force"),
  projectId: flag("--project"),
  spaceId: flag("--space"),
});

console.log(`✓ digests: ${res.sent} sent / ${res.due} due / ${res.considered} enabled`);
for (const r of res.results) {
  const tag = r.ok
    ? r.skipped === "no-content" ? "· skip (no new content)" : `✓ ${r.status}`
    : `✗ ${r.error ?? r.status ?? "failed"}`;
  console.log(`  ${r.spaceId} ${tag}${r.entityCount != null ? ` (${r.entityCount} entities)` : ""}`);
}
process.exit(0);
