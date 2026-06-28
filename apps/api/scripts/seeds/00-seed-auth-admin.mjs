// Admin seed MASTER — prompt once for an admin email + password, then seed the matching auth backend.
//
// Agora picks an auth backend PER PROJECT (projects.auth_provider). Rather than make you remember which
// of the two backend-specific seeders to run, this asks for the credentials ONCE and hands them to BOTH
// helpers in helpers/ (env-driven, so neither re-prompts):
//   • helpers/seed-native-auth-admin.mjs    → writes an `auth_credentials` row (in-API argon2 backend)
//   • helpers/seed-supabase-auth-admin.mjs  → creates a confirmed Supabase auth user
// Each helper self-gates on the project's auth_provider: the ACTIVE backend is seeded, the other prints a
// one-line skip (so there's no dead data and no double prompt). Pass --force to seed both regardless.
//
// This is the file the `seed.mjs` orchestrator discovers (the helpers live in a subfolder it doesn't
// scan). Runs interactively (prompts) or non-interactively when ADMIN_EMAIL/ADMIN_PASSWORD (or
// DEMO_EMAIL/DEMO_PASSWORD) are set.
//
//   node scripts/seeds/00-seed-auth-admin.mjs          # prompt once, seed the active backend
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node …              # non-interactive (CI); env wins over the prompt
//   ... --test     # target TEST_DATABASE_URL (forwarded to both helpers)
//   ... --reset    # reset the native credential's password (forwarded; native only)
//   ... --force    # seed BOTH backends even if only one is active (forwarded to both helpers)
//
// The default (DemoPass123!) is shown in the prompt as a hint — press Enter to accept it (fine for the
// demo/dev login the post seeders sign in as; change it for any real deployment). But a password you
// actually TYPE is hidden (echo off), so a real credential never lands on screen, in argv, `ps`, or
// shell history. For a non-interactive secret, set ADMIN_PASSWORD in the env.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2); // forwarded verbatim to each helper (--test/--reset/--force)

const DEMO_EMAIL = "agora-admin@gmail.com";
const DEMO_PASSWORD = "DemoPass123!";

// Prompt on the TTY. The query label is always shown; with { hidden: true } the typed keystrokes that
// FOLLOW are not echoed (password entry — the visible default hint stays, the secret you type doesn't).
// Returns the trimmed line; rejects when there's no interactive terminal (caller falls back to a default).
function ask(query, { hidden = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("no TTY"));
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
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

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── Resolve the shared credentials ONCE ─────────────────────────────────────────────────────────
// Email: ADMIN_EMAIL / DEMO_EMAIL env wins; else prompt (empty = demo default).
let email = (process.env.ADMIN_EMAIL || process.env.DEMO_EMAIL)?.trim().toLowerCase();
if (!email) {
  email = (await ask(`Admin email [${DEMO_EMAIL}]: `).catch(() => "")) || DEMO_EMAIL;
  email = email.toLowerCase();
}
if (!email.includes("@")) fail("A valid email is required.");

// Password: ADMIN_PASSWORD / DEMO_PASSWORD env wins; else prompt. Enter = demo default (hint shown);
// a typed password is hidden (echo off) and confirmed twice (hidden entry → guard against a typo).
let password = process.env.ADMIN_PASSWORD || process.env.DEMO_PASSWORD;
if (!password) {
  const typed = await ask(`Admin password [${DEMO_PASSWORD}]: `, { hidden: true }).catch(() => "");
  if (!typed) {
    password = DEMO_PASSWORD;
    console.warn("⚠ using the known demo password — change it for any non-demo deployment.");
  } else {
    const confirm = await ask("Confirm password: ", { hidden: true }).catch(() => "");
    if (typed !== confirm) fail("Passwords don't match.");
    password = typed;
  }
}
if (password.length < 8) fail("Password must be at least 8 characters.");

// Hand the resolved creds to both helpers via env (both names so each reads its own): native reads
// ADMIN_*, supabase reads DEMO_*. Set non-interactively so neither helper re-prompts.
const childEnv = {
  ...process.env,
  ADMIN_EMAIL: email,
  ADMIN_PASSWORD: password,
  DEMO_EMAIL: email,
  DEMO_PASSWORD: password,
};

const helpers = [
  { label: "native", file: "helpers/seed-native-auth-admin.mjs" },
  { label: "supabase", file: "helpers/seed-supabase-auth-admin.mjs" },
];

const failures = [];
for (const { label, file } of helpers) {
  console.log(`\n──▶ ${label}`);
  const res = spawnSync(process.execPath, [join(here, file), ...argv], { stdio: "inherit", env: childEnv });
  if (res.status !== 0) failures.push(label);
}

if (failures.length) {
  console.error(`\n⚠️  admin seed finished with errors: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n✅ admin seed complete — credentials seeded for the project's active backend (${email}).`);
