// Seed a pre-confirmed NATIVE (Agora-owned) admin credential — for the SELF-HOSTED, no-Supabase
// auth backend ONLY. The Supabase counterpart is the sibling `seed-supabase-auth-admin.mjs`.
//
// This lives in helpers/ so the `seed.mjs` orchestrator (which scans only the top-level seeds dir)
// doesn't pick it up directly — it's driven by the `../00-seed-auth-admin.mjs` master, which prompts
// once and runs both backends. It also runs standalone (creds via env or its own prompt).
//
// ┌─ WHICH ADMIN IS THIS? ───────────────────────────────────────────────────────────────────────┐
// │ Agora picks an auth backend PER PROJECT (projects.auth_provider, resolved by lib/auth's        │
// │ getAuthProvider). The two admin seeders are NOT interchangeable — one per backend:             │
// │   • NATIVE  (auth_provider='native')   → THIS script. Writes an `auth_credentials` row; sign-in │
// │       is the in-API argon2 backend. Used by a fully self-hosted deploy (no Supabase).           │
// │   • SUPABASE (auth_provider='supabase') → `seed-supabase-auth-admin.mjs`. Writes a Supabase     │
// │       auth user; sign-in routes to Supabase. This is the DEFAULT backend.                       │
// │ On a SUPABASE project the local auth subsystem never runs, so a native `auth_credentials` row   │
// │ is DEAD DATA sign-in never reads. This script therefore SKIPS itself (exit 0) when the project's │
// │ auth_provider != 'native' — pass --force only if you're about to switch the project to native.  │
// └────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// For a native deploy a virgin DB has no users; this inserts a confirmed auth_credentials row so
// email/password sign-in works immediately, skipping the email-confirmation round-trip (the default
// ConsoleEmailSender only logs the link). The matching `profiles` row auto-creates + links on first
// sign-in (ensureProfile in routes/auth.ts).
//
// God-view ("operator") is the OPERATOR_EMAILS / OPERATOR_USER_IDS env allowlist (lib/operators.ts),
// NOT a DB row — so add this email to OPERATOR_EMAILS in .env to make it an admin. See docs/SELF-HOSTING.md.
//
//   node scripts/seeds/helpers/seed-native-auth-admin.mjs   # prompts for email + password (no echo)
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node …                   # non-interactive (CI / master); env wins
//   ... --test     # target TEST_DATABASE_URL instead of DATABASE_URL
//   ... --reset    # the (project,email) already exists → set a new password + (re)confirm it
//   ... --force    # seed even when auth_provider != 'native' (you're about to switch to native)
//
// Credentials come from ADMIN_EMAIL / ADMIN_PASSWORD when set, else an interactive prompt — the password
// is read with echo OFF and confirmed twice, so it never lands in argv, `ps`, or shell history.
// Idempotent: re-running without --reset reports "already exists" and changes nothing (no clobber).
import "dotenv/config";
import postgres from "postgres";
import { hash } from "@node-rs/argon2";
import readline from "node:readline";

const args = new Set(process.argv.slice(2));
const isTest = args.has("--test");
const reset = args.has("--reset");
const force = args.has("--force");

// Prompt on the TTY. With { hidden: true } the typed characters are not echoed (password entry). Returns
// the trimmed line. Throws if there's no interactive terminal (caller falls back to an env-or-error path).
function ask(query, { hidden = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("no TTY"));
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    // rl.question writes the prompt synchronously through this hook; we mute only AFTER it's shown, so the
    // label is visible but the keystrokes that follow are not.
    rl._writeToOutput = (str) => {
      if (!muted) rl.output.write(str);
    };
    rl.question(query, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
    if (hidden) muted = true;
  });
}

const urlVar = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
const url = process.env[urlVar];
if (!url) {
  console.error(`✗ ${urlVar} required in .env`);
  process.exit(1);
}

// Defaults to the genesis seed project so a fresh `node scripts/genesis.mjs` DB works out of the box.
// PROJECT_ID (the var every content seeder honors) is the fallback so one env retargets the whole
// seed flow at a non-default project; ADMIN_PROJECT_ID stays the specific override.
const projectId = process.env.ADMIN_PROJECT_ID || process.env.PROJECT_ID || "11111111-1111-1111-1111-111111111111";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice() {} });

// ── Provider gate (BEFORE we prompt for anything) ───────────────────────────────────────────────
// The project must exist, and a native credential is only honored when auth_provider='native'. On a
// Supabase project the local auth subsystem never runs (sign-in routes to Supabase), so this row would
// be dead data — skip cleanly so the master/orchestrator isn't blocked on a useless password prompt.
// `--force` overrides (you're about to flip the project to native). We check this FIRST so a Supabase
// run never even asks for an email.
const [project] = await sql`select auth_provider from projects where id = ${projectId}`;
if (!project) {
  console.error(`✗ project ${projectId} not found — run \`node scripts/genesis.mjs\` first (or set ADMIN_PROJECT_ID).`);
  await sql.end();
  process.exit(1);
}
if (project.auth_provider !== "native" && !force) {
  console.log(`↷ skipping native-admin seed — project ${projectId} uses auth_provider='${project.auth_provider}'.`);
  console.log(`  This script is for the SELF-HOSTED native backend only; a '${project.auth_provider}' project's`);
  console.log(`  admin is seeded by seed-supabase-auth-admin.mjs and sign-in never reads auth_credentials.`);
  console.log(`  Pass --force to seed anyway (e.g. you're about to switch this project to native).`);
  await sql.end();
  process.exit(0);
}
if (project.auth_provider !== "native") {
  console.warn(`⚠ --force: project ${projectId} has auth_provider='${project.auth_provider}', not 'native' — this`);
  console.warn(`  credential won't be used for sign-in until you switch it:`);
  console.warn(`    update projects set auth_provider='native' where id='${projectId}';`);
}

// Email: env wins; else prompt. Light validation — non-empty + contains "@".
let email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
if (!email) {
  email = await ask("Admin email: ").catch(() =>
    fail("ADMIN_EMAIL not set and no interactive terminal — set ADMIN_EMAIL or run from a TTY."));
}
if (!email || !email.includes("@")) fail("A valid email is required.");

// Password: env wins; else prompt with echo OFF, confirmed twice. A real admin credential must never have
// a known/default password, so there's no default — it's required either way.
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  password = await ask("Admin password (hidden): ", { hidden: true }).catch(() =>
    fail("ADMIN_PASSWORD not set and no interactive terminal — set ADMIN_PASSWORD or run from a TTY."));
  const confirm = await ask("Confirm password (hidden): ", { hidden: true }).catch(() => "");
  if (password !== confirm) fail("Passwords don't match.");
}
if (!password || password.length < 8) fail("Password must be at least 8 characters.");

try {
  const [existing] = await sql`
    select id, email_confirmed_at from auth_credentials
    where project_id = ${projectId} and email = ${email} limit 1`;

  const passwordHash = await hash(password); // argon2id, self-describing PHC string (verifyPassword reads it back)

  if (existing && !reset) {
    console.log(`✓ native admin already exists: ${email} (id ${existing.id}) — unchanged. Pass --reset to set a new password.`);
    process.exit(0);
  }

  if (existing) {
    await sql`
      update auth_credentials
      set password_hash = ${passwordHash}, email_confirmed_at = now(), updated_at = now()
      where id = ${existing.id}`;
    console.log(`✓ reset native admin password + reconfirmed: ${email} (id ${existing.id})`);
  } else {
    const [cred] = await sql`
      insert into auth_credentials (project_id, email, password_hash, email_confirmed_at)
      values (${projectId}, ${email}, ${passwordHash}, now())
      returning id`;
    console.log(`✓ created confirmed native admin: ${email} (id ${cred.id})`);
  }

  console.log(`  → next: add ${email} to OPERATOR_EMAILS in .env for god-view, then sign in (the profile auto-creates).`);
} catch (err) {
  console.error("\n✗ seed-native-auth-admin failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
