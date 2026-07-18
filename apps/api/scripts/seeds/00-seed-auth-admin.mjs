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
import { resolveAdminCreds, credsEnv } from "./helpers/resolve-admin-creds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2); // forwarded verbatim to each helper (--test/--reset/--force)

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── Resolve the shared credentials ONCE ─────────────────────────────────────────────────────────
// Delegated to the shared resolver so the `seed.mjs` orchestrator resolves the SAME way and can
// propagate the result to the post-seeders (a typed password must reach them, not the demo default).
// Env (ADMIN_*/DEMO_*) wins over the prompt; a typed password is hidden + confirmed twice.
const { email, password } = await resolveAdminCreds().catch((err) => fail(err.message));

// Hand the resolved creds to both helpers via env (both names so each reads its own): native reads
// ADMIN_*, supabase reads DEMO_*. Set non-interactively so neither helper re-prompts.
const childEnv = { ...process.env, ...credsEnv({ email, password }) };

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
