// ⚠️  DESTRUCTIVE — wipes the Agora backend to a clean slate. Run from agora/server.
//
// Clears, in order:
//   1. App data    — TRUNCATE ... RESTART IDENTITY CASCADE on all public tables (schema kept).
//                    The `projects` + `project_integrations` tenant rows are PRESERVED by default
//                    (without them the server can't resolve :projectId); pass --include-projects
//                    to wipe those too (then re-seed: psql ... -f scripts/seeds/seed.sql).
//   2. Auth users  — deletes every Supabase Auth user via the admin API.
//   3. Storage      — empties the `agora` Storage bucket (recursively).
//
// Safety:
//   • DRY RUN by default — prints the target + what WOULD be deleted, changes nothing.
//   • Pass --yes to actually execute. In a TTY you must then type the Supabase project ref to
//     confirm (skip the prompt in CI with --force).
//   • Targets are derived from DATABASE_URL + SUPABASE_URL in your .env — double-check them.
//
// Usage:
//   node scripts/wipe.mjs                       # dry run (safe)
//   node scripts/wipe.mjs --yes                 # wipe data + auth + storage (interactive confirm)
//   node scripts/wipe.mjs --yes --force         # non-interactive (CI)
//   node scripts/wipe.mjs --yes --no-auth --no-storage   # data only
//   node scripts/wipe.mjs --yes --include-projects       # also wipe tenant rows (total nuke)
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

// ── args ──────────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const EXECUTE = args.has("--yes") || args.has("-y");
const FORCE = args.has("--force");
const INCLUDE_PROJECTS = args.has("--include-projects");
const DO_DATA = !args.has("--no-data");
const DO_AUTH = !args.has("--no-auth");
const DO_STORAGE = !args.has("--no-storage");
const BUCKET = "agora";

// Tenant/config rows that keep the server functional — preserved unless --include-projects.
const PROJECT_TABLES = ["projects", "project_integrations"];
// Every other public table (content, identity-profiles, social graph, chat, embeddings, tokens…).
const DATA_TABLES = [
  "app_notifications", "chat_message_reactions", "chat_messages", "collection_entities",
  "collections", "comments", "connections", "content_embeddings", "conversation_members",
  "conversations", "entities", "entity_embeddings", "files", "follows", "oauth_identities",
  "oauth_states", "profiles", "reactions", "refresh_tokens", "reports", "space_members",
  "space_rules", "spaces", "user_suspensions",
];
const tablesToWipe = INCLUDE_PROJECTS ? [...DATA_TABLES, ...PROJECT_TABLES] : DATA_TABLES;

// ── env / targets ───────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
const sbUrl = process.env.SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dbUrl) die("DATABASE_URL required (.env).");
if ((DO_AUTH || DO_STORAGE) && (!sbUrl || !sbKey)) {
  die("Auth/Storage wipe needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or pass --no-auth --no-storage).");
}
const dbHost = safeHost(dbUrl);
const sbRef = sbUrl ? new URL(sbUrl).host.split(".")[0] : "(none)";

console.log("⚠️  Agora WIPE");
console.log(`   DB target      : ${dbHost}`);
console.log(`   Supabase ref   : ${sbRef}`);
console.log(`   App data       : ${DO_DATA ? `${tablesToWipe.length} tables` : "skip"}${DO_DATA && !INCLUDE_PROJECTS ? "  (projects + project_integrations preserved)" : ""}`);
console.log(`   Auth users     : ${DO_AUTH ? "DELETE ALL" : "skip"}`);
console.log(`   Storage bucket : ${DO_STORAGE ? `${BUCKET} (empty)` : "skip"}`);
console.log("");

const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice() {} });
const admin = (DO_AUTH || DO_STORAGE)
  ? createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

try {
  // ── DRY RUN: report counts, change nothing ──────────────────────────────────
  if (!EXECUTE) {
    console.log("DRY RUN (no --yes) — nothing will be deleted.\n");
    if (DO_DATA) {
      let total = 0;
      for (const t of tablesToWipe) {
        const [{ n }] = await sql`select count(*)::int as n from ${sql(t)}`;
        total += n;
        if (n > 0) console.log(`   ${t}: ${n}`);
      }
      console.log(`   → ${total} app rows across ${tablesToWipe.length} tables`);
    }
    if (DO_AUTH) console.log(`   → auth users: ${await countAuthUsers(admin)}`);
    if (DO_STORAGE) console.log(`   → storage objects: ${(await listAllObjects(admin)).length}`);
    console.log("\nRe-run with --yes to execute.");
    process.exit(0);
  }

  // ── confirmation gate ───────────────────────────────────────────────────────
  if (!FORCE && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Type the Supabase ref "${sbRef}" to confirm IRREVERSIBLE wipe: `);
    rl.close();
    if (answer.trim() !== sbRef) die("Confirmation did not match — aborted. Nothing was deleted.");
  } else if (!FORCE) {
    die("Refusing non-interactive wipe without --force. Re-run with --yes --force.");
  }

  // ── 1. app data ──────────────────────────────────────────────────────────────
  if (DO_DATA) {
    const list = tablesToWipe.map((t) => `"${t}"`).join(", ");
    await sql.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
    console.log(`✓ truncated ${tablesToWipe.length} tables`);
  }

  // ── 2. auth users ────────────────────────────────────────────────────────────
  if (DO_AUTH) {
    let deleted = 0;
    // Fetch page 1 repeatedly: each delete shrinks the set, so this drains it without pagination drift.
    for (;;) {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) die(`listUsers failed: ${error.message}`);
      const users = data?.users ?? [];
      if (users.length === 0) break;
      for (const u of users) {
        const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
        if (delErr) die(`deleteUser ${u.id} failed: ${delErr.message}`);
        deleted++;
      }
    }
    console.log(`✓ deleted ${deleted} auth users`);
  }

  // ── 3. storage ────────────────────────────────────────────────────────────────
  if (DO_STORAGE) {
    const paths = await listAllObjects(admin);
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { error } = await admin.storage.from(BUCKET).remove(batch);
      if (error) die(`storage remove failed: ${error.message}`);
    }
    console.log(`✓ removed ${paths.length} storage objects from "${BUCKET}"`);
  }

  console.log("\n✅ wipe complete.");
  if (INCLUDE_PROJECTS) console.log("   Tenant rows were wiped — re-seed before use: psql \"$DATABASE_URL\" -f scripts/seeds/seed.sql");
} finally {
  await sql.end();
}
process.exit(0);

// ── helpers ─────────────────────────────────────────────────────────────────
async function countAuthUsers(admin) {
  let total = 0, page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) die(`listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    total += users.length;
    if (users.length < 200) break;
    page++;
  }
  return total;
}

// Recursively walk the bucket; Supabase .list() returns folders (id === null) and files per prefix.
async function listAllObjects(admin, prefix = "") {
  const out = [];
  const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) {
    if (/not.*found|bucket/i.test(error.message)) return out; // bucket may not exist yet
    die(`storage list failed: ${error.message}`);
  }
  for (const item of data ?? []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id === null) out.push(...(await listAllObjects(admin, path))); // folder
    else out.push(path);
  }
  return out;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return "(unparseable DATABASE_URL)"; }
}
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
