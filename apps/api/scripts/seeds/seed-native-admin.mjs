// Seed a pre-confirmed NATIVE (Agora-owned) admin credential — the no-Supabase counterpart of
// seed-demo-user.mjs. For a fully self-hosted deploy (projects.auth_provider='native'), a virgin DB has
// no users; this inserts a confirmed auth_credentials row so email/password sign-in works immediately,
// skipping the email-confirmation round-trip (the default ConsoleEmailSender only logs the link). The
// matching `profiles` row auto-creates + links on first sign-in (ensureProfile in routes/auth.ts).
//
// God-view ("operator") is the OPERATOR_EMAILS / OPERATOR_USER_IDS env allowlist (lib/operators.ts),
// NOT a DB row — so add this email to OPERATOR_EMAILS in .env to make it an admin. See docs/SELF-HOSTING.md.
//
//   node scripts/seeds/seed-native-admin.mjs           # prompts for email + password (no echo)
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node …              # non-interactive (CI); env wins over the prompt
//   ... --test     # target TEST_DATABASE_URL instead of DATABASE_URL
//   ... --reset    # the (project,email) already exists → set a new password + (re)confirm it
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
const projectId = process.env.ADMIN_PROJECT_ID || "11111111-1111-1111-1111-111111111111";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
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

const sql = postgres(url, { max: 1, prepare: false, onnotice() {} });
try {
  // FK + provider sanity: the project must exist, and a native credential is only honored when the
  // project's auth_provider is 'native' (otherwise sign-in routes to Supabase). Warn, don't block.
  const [project] = await sql`select auth_provider from projects where id = ${projectId}`;
  if (!project) {
    console.error(`✗ project ${projectId} not found — run \`node scripts/genesis.mjs\` first (or set ADMIN_PROJECT_ID).`);
    process.exit(1);
  }
  if (project.auth_provider !== "native") {
    console.warn(`⚠ project ${projectId} has auth_provider='${project.auth_provider}', not 'native' — this`);
    console.warn(`  credential won't be used for sign-in until you switch it:`);
    console.warn(`    update projects set auth_provider='native' where id='${projectId}';`);
  }

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
  console.error("\n✗ seed-native-admin failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
