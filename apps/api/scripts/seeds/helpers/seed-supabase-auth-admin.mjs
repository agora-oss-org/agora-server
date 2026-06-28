// Seed a pre-confirmed SUPABASE auth user — for the Supabase-backed auth backend (the DEFAULT).
// The native counterpart is the sibling `seed-native-auth-admin.mjs`.
//
// This lives in helpers/ so the `seed.mjs` orchestrator (which scans only the top-level seeds dir)
// doesn't pick it up directly — it's driven by the `../00-seed-auth-admin.mjs` master, which prompts
// once and runs both backends. It also runs standalone (creds via env or the demo defaults).
//
// ┌─ WHICH ADMIN IS THIS? ───────────────────────────────────────────────────────────────────────┐
// │ Agora picks an auth backend PER PROJECT (projects.auth_provider, resolved by lib/auth's        │
// │ getAuthProvider). The two admin seeders are NOT interchangeable — one per backend:             │
// │   • SUPABASE (auth_provider='supabase') → THIS script. Creates a confirmed Supabase auth user; │
// │       sign-in routes to Supabase. This is the DEFAULT backend (and the demo-app login).         │
// │   • NATIVE  (auth_provider='native')   → `seed-native-auth-admin.mjs`. Writes an               │
// │       `auth_credentials` row; sign-in is the in-API argon2 backend (fully self-hosted).         │
// │ On a NATIVE project Supabase is never contacted at sign-in, so a Supabase auth user is unused — │
// │ this script SKIPS itself (exit 0) when the project's auth_provider != 'supabase'. Pass --force  │
// │ only if you're about to switch the project to Supabase.                                         │
// └────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// Creating the user pre-confirmed skips the email-confirmation round-trip so email/password sign-in
// works immediately. The matching `profiles` row auto-creates + links on first sign-in (ensureProfile
// in routes/auth.ts). Idempotent: re-running reports "already exists" and changes nothing.
//
// God-view ("operator") is the OPERATOR_EMAILS / OPERATOR_USER_IDS env allowlist (lib/operators.ts),
// NOT a DB row — so add this email to OPERATOR_EMAILS in .env to make it an admin. See docs/SELF-HOSTING.md.
//
//   node scripts/seeds/helpers/seed-supabase-auth-admin.mjs   # uses DEMO_EMAIL / DEMO_PASSWORD (or demo defaults)
//   DEMO_EMAIL=… DEMO_PASSWORD=… node …                       # override the seeded credentials
//   ... --test     # target TEST_DATABASE_URL for the provider gate (instead of DATABASE_URL)
//   ... --force    # seed even when auth_provider != 'supabase' (you're about to switch to Supabase)
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the admin API). Unlike the native seeder this
// keeps a known demo default password (DemoPass123!) — it's the demo-app login, intentionally shared.
import "dotenv/config";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const args = new Set(process.argv.slice(2));
const isTest = args.has("--test");
const force = args.has("--force");

const urlVar = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
const dbUrl = process.env[urlVar];
if (!dbUrl) {
  console.error(`✗ ${urlVar} required in .env`);
  process.exit(1);
}

// Defaults to the genesis seed project so a fresh `node scripts/genesis.mjs` DB works out of the box.
const projectId = process.env.ADMIN_PROJECT_ID || "11111111-1111-1111-1111-111111111111";

// ── Provider gate (BEFORE we touch Supabase) ────────────────────────────────────────────────────
// Symmetric with seed-native-auth-admin.mjs: a Supabase auth user is only honored when the project's
// auth_provider='supabase'. On a native project sign-in never contacts Supabase, so skip cleanly so
// the master/orchestrator isn't left with a stray Supabase user. `--force` overrides.
const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice() {} });
let provider;
try {
  const [project] = await sql`select auth_provider from projects where id = ${projectId}`;
  if (!project) {
    console.error(`✗ project ${projectId} not found — run \`node scripts/genesis.mjs\` first (or set ADMIN_PROJECT_ID).`);
    process.exit(1);
  }
  provider = project.auth_provider;
} finally {
  await sql.end();
}

if (provider !== "supabase" && !force) {
  console.log(`↷ skipping supabase-admin seed — project ${projectId} uses auth_provider='${provider}'.`);
  console.log(`  This script is for the Supabase backend only; a '${provider}' project's admin is seeded`);
  console.log(`  by seed-native-auth-admin.mjs and sign-in never contacts Supabase.`);
  console.log(`  Pass --force to seed anyway (e.g. you're about to switch this project to Supabase).`);
  process.exit(0);
}
if (provider !== "supabase") {
  console.warn(`⚠ --force: project ${projectId} has auth_provider='${provider}', not 'supabase' — this user`);
  console.warn(`  won't be used for sign-in until you switch it:`);
  console.warn(`    update projects set auth_provider='supabase' where id='${projectId}';`);
}

// Supabase admin API creds — only required now that we know this project is Supabase-backed.
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("✗ Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (.env) to seed a Supabase auth user.");
  process.exit(1);
}

const email = process.env.DEMO_EMAIL || "agora-admin@gmail.com";
const password = process.env.DEMO_PASSWORD || "DemoPass123!";

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });

if (error) {
  if (/already|exist|registered/i.test(error.message)) {
    console.log(`✓ supabase admin already exists: ${email}`);
    process.exit(0);
  }
  console.error("✗ createUser failed:", error.message);
  process.exit(1);
}
console.log(`✓ created confirmed supabase admin: ${email}  (id ${data.user.id})`);
console.log(`  → next: add ${email} to OPERATOR_EMAILS in .env for god-view, then sign in (the profile auto-creates).`);
