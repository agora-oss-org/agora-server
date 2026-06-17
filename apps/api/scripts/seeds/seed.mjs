// Orchestrator — runs every sibling seed script (`*.mjs` in this folder, except itself) in sequence.
//   node scripts/seeds/seed.mjs            # or: pnpm seed
// Ordering: the account-creating script (`seed-demo-user.mjs`) runs FIRST, since every post seeder
// signs in as that user; if it fails the run aborts (the posts can't authenticate). The remaining
// post seeders run alphabetically — each is independent and idempotent (skips if its post exists),
// so a single image-fetch failure is reported but doesn't stop the rest. Exit code is non-zero if
// any seeder failed.
//
// NOTE: this runs the `.mjs` seeders only. Tenant rows + trigger/RPC validation live in `seed.sql`
// (run separately: psql "$DATABASE_URL" -f scripts/seeds/seed.sql) — the post seeders need the
// project row to exist, and `seed-demo-user.mjs` needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const SELF = "seed.mjs";
// The manifest-driven seed engine is run on its own (`pnpm seed:graph`), not as part of this
// orchestrator — it's a different paradigm (declarative manifest) and creates its own users.
const EXCLUDE = new Set([SELF, "seed-engine.mjs"]);

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
for (const file of ordered) {
  console.log(`\n──▶ ${file}`);
  const res = spawnSync(process.execPath, [join(here, file)], { stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    failures.push(file);
    // A failing account seeder is fatal — the post seeders can't sign in without it.
    if (file.includes("user")) {
      console.error(`\n✗ ${file} failed (exit ${res.status ?? "signal"}) — aborting; the post seeders need this user.`);
      process.exit(res.status || 1);
    }
    console.error(`✗ ${file} failed (exit ${res.status ?? "signal"}) — continuing.`);
  }
}

const ok = ordered.length - failures.length;
console.log(
  `\n${failures.length ? "⚠️ " : "✅"} done — ${ok}/${ordered.length} succeeded` +
    (failures.length ? `; failed: ${failures.join(", ")}` : "."),
);
process.exit(failures.length ? 1 : 0);
