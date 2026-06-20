// IUC restore-blob TTL sweep — deletes EXPIRED restore blobs from the secure-chat relay. Run from
// apps/secure-chat. This is the manual/standalone twin of POST /internal/cron/purge-restore-blobs.
//
// Restore blobs are an ephemeral courier drop-box: device A uploads a sealed history blob for a
// re-provisioned device B, B fetches + DELETEs it on confirm, and anything B never confirms is swept
// here once past its TTL (SECURE_RESTORE_BLOB_TTL_SECONDS, default 15 min). Lazy-expiry already hides
// expired blobs on read, so this only reclaims storage — it is safe to run any time. Opaque ciphertext
// only; the server holds no key/plaintext to leak.
//
// Safety:
//   • DRY RUN by default — prints the target + the count of expired blobs, deletes nothing.
//   • Pass --yes to actually delete. Target is derived from DATABASE_URL in your .env.
//
// Usage:
//   node scripts/purge-restore-blobs.mjs          # dry run (safe) — show how many are expired
//   node scripts/purge-restore-blobs.mjs --yes     # delete expired restore blobs
//   pnpm db:purge:restore-blobs                     # dry run via package.json
//   pnpm db:purge:restore-blobs --yes               # execute
import "dotenv/config";
import postgres from "postgres";

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has("--yes") || args.has("-y");

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) die("DATABASE_URL required (.env).");

console.log("⚠️  Agora secure-chat PURGE-RESTORE-BLOBS (TTL sweep)");
console.log(`   DB target : ${safeHost(dbUrl)}`);
console.log("");

const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice() {} });

try {
  const [{ n }] = await sql`select count(*)::int as n from secure_restore_blobs where expires_at <= now()`;
  console.log(`   Expired restore blobs: ${n}`);
  console.log("");

  if (!EXECUTE) {
    console.log("DRY RUN (no --yes) — nothing was deleted. Re-run with --yes to execute.");
    process.exit(0);
  }

  const deleted = await sql`delete from secure_restore_blobs where expires_at <= now() returning id`;
  console.log(`✓ purged ${deleted.length} expired restore blobs`);
  console.log("\n✅ restore-blob TTL sweep complete.");
} finally {
  await sql.end();
}
process.exit(0);

// ── helpers ─────────────────────────────────────────────────────────────────
function safeHost(url) {
  try { return new URL(url).host; } catch { return "(unparseable DATABASE_URL)"; }
}
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
