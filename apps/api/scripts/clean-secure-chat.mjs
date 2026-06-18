// ⚠️  DESTRUCTIVE (scoped) — wipes the secure-chat (E2E/MLS) relay tables to a clean slate for a
// fresh testing iteration. Run from agora/server (apps/api).
//
// Clears ONLY the seven `secure_*` Delivery-Service tables (devices, key packages, conversations,
// members, messages, handshake queue, key backups) with TRUNCATE ... RESTART IDENTITY CASCADE.
// This also resets the `secure_handshake_messages.seq` bigserial cursor back to 1, so the
// device-row / delivery-cursor churn that muddies the diagnostics starts fresh too. The schema is
// kept; plaintext chat, profiles, projects, and everything else are untouched.
//
// ⚠️  Server-side only. The clients still hold their MLS group state + device keys in browser
// IndexedDB/localStorage — clear those too, or a client will try to resume against group state the
// server no longer has. (See docs/SECURE-CHAT-DIAG-HARNESS.md.)
//
// Safety:
//   • DRY RUN by default — prints the target + current row counts, changes nothing.
//   • Pass --yes to actually execute. Target is derived from DATABASE_URL in your .env.
//
// Usage:
//   node scripts/clean-secure-chat.mjs          # dry run (safe) — show counts
//   node scripts/clean-secure-chat.mjs --yes     # truncate the secure_* tables
//   pnpm db:clean:secure-chat                     # dry run via package.json
//   pnpm db:clean:secure-chat --yes               # execute
import "dotenv/config";
import postgres from "postgres";

// ── args ──────────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const EXECUTE = args.has("--yes") || args.has("-y");

// Listed children-before-parents (CASCADE makes order moot, but it documents the FK graph).
const SECURE_TABLES = [
  "secure_handshake_messages",
  "secure_messages",
  "secure_conversation_members",
  "secure_conversations",
  "secure_key_packages",
  "secure_key_backups",
  "secure_devices",
];

// ── env / target ───────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) die("DATABASE_URL required (.env).");
const dbHost = safeHost(dbUrl);

console.log("⚠️  Agora secure-chat CLEAN");
console.log(`   DB target : ${dbHost}`);
console.log(`   Tables    : ${SECURE_TABLES.length} secure_* relay tables`);
console.log("");

const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice() {} });

try {
  // ── report counts (always) ─────────────────────────────────────────────────
  let total = 0;
  for (const t of SECURE_TABLES) {
    const [{ n }] = await sql`select count(*)::int as n from ${sql(t)}`;
    total += n;
    console.log(`   ${t.padEnd(30)} ${n}`);
  }
  console.log(`   ${"→ total".padEnd(30)} ${total} rows`);
  console.log("");

  // ── DRY RUN: change nothing ──────────────────────────────────────────────────
  if (!EXECUTE) {
    console.log("DRY RUN (no --yes) — nothing was deleted. Re-run with --yes to execute.");
    process.exit(0);
  }

  // ── execute ──────────────────────────────────────────────────────────────────
  const list = SECURE_TABLES.map((t) => `"${t}"`).join(", ");
  await sql.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
  console.log(`✓ truncated ${SECURE_TABLES.length} secure_* tables (identities reset)`);
  console.log("\n✅ secure-chat tables clean. Remember to clear client-side state (IndexedDB/localStorage) too.");
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
