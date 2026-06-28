// Orchestrator — runs every sibling seed script (`*.mjs` in this folder, except itself) in sequence.
//   node scripts/seeds/seed.mjs            # or: pnpm seed
// Ordering: the admin-login seeder (`00-seed-auth-admin.mjs`) runs FIRST, since every post seeder
// signs in as that user; if it fails the run aborts (the posts can't authenticate). The remaining
// seeders run by filename — each is independent and idempotent (skips if its row exists), so a single
// image-fetch failure is reported but doesn't stop the rest. Exit code is non-zero if any seeder failed.
//
// STOP signal: a gate seeder (e.g. `01-confirm-demo-data.mjs`) may exit with STOP_CODE (78) to halt the
// run CLEANLY — the remaining seeders are skipped, not failed. This is distinct from a real failure
// (any other non-zero exit), so an opt-out and a crash are never confused.
//
// NOTE: this runs the `.mjs` seeders only. Tenant rows + trigger/RPC validation live in `seed.sql`
// (run separately: psql "$DATABASE_URL" -f scripts/seeds/seed.sql) — the post seeders need the
// project row to exist, and the admin seed (`00-seed-auth-admin.mjs`) needs DATABASE_URL (native) and/or
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (supabase).
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const SELF = "seed.mjs";
const STOP_CODE = 78; // a gate seeder exits with this to halt the run cleanly (keep in sync with the gate)
// The manifest-driven seed engine (`03-seed-engine.mjs`) runs here too (gated by 01-confirm-demo-data),
// and standalone via `pnpm seed:graph`. ⚠ It is NOT idempotent — re-running duplicates its graph world
// (and toggles its reactions off), so wipe the DB before a re-seed.
const EXCLUDE = new Set([SELF]);

const all = readdirSync(here).filter((f) => f.endsWith(".mjs") && !EXCLUDE.has(f)).sort();
// Account-creating scripts before the post seeders that depend on them.
const userFirst = all.filter((f) => f.includes("user"));
const rest = all.filter((f) => !f.includes("user"));
const ordered = [...userFirst, ...rest];

if (ordered.length === 0) {
  console.log("No seed scripts found in", here);
  process.exit(0);
}

console.log(`🌱 Seeding — ${ordered.length} script(s) in ${here}`);

const failures = [];
let ran = 0;
let stopped = null; // set to the gate filename if a seeder requested a clean STOP
for (const file of ordered) {
  console.log(`\n──▶ ${file}`);
  const res = spawnSync(process.execPath, [join(here, file)], { stdio: "inherit", env: process.env });
  // Clean STOP (gate opt-out) — halt the run, but it's not a failure.
  if (res.status === STOP_CODE) {
    stopped = file;
    break;
  }
  ran++;
  if (res.status !== 0) {
    failures.push(file);
    // A failing account seeder is fatal — the post seeders can't sign in without it.
    if (file.includes("admin") || file.includes("user")) {
      console.error(`\n✗ ${file} failed (exit ${res.status ?? "signal"}) — aborting; the post seeders need this login.`);
      process.exit(res.status || 1);
    }
    console.error(`✗ ${file} failed (exit ${res.status ?? "signal"}) — continuing.`);
  }
}

const ok = ran - failures.length;
const skipped = stopped ? ordered.length - ran : 0;
console.log(
  `\n${failures.length ? "⚠️ " : "✅"} done — ${ok}/${ran} succeeded` +
    (stopped ? `; stopped at ${stopped} (${skipped} seeder(s) skipped)` : "") +
    (failures.length ? `; failed: ${failures.join(", ")}` : "."),
);
process.exit(failures.length ? 1 : 0);
