// 🌱 GENESIS — from nothing to a valid, seeded schema in one command.
//   Drop the schema → rebuild from migrations (0000…N) → seed fixtures + validate triggers/RPC.
//
//   node scripts/genesis.mjs            # DEV  → DATABASE_URL
//   node scripts/genesis.mjs --test     # TEST → TEST_DATABASE_URL
//   node scripts/genesis.mjs --force    # skip the type-the-ref confirm (CI / non-interactive)
//
// DESTRUCTIVE. This wraps `drop.mjs --yes --migrate` (which drops private/drizzle/public and rebuilds
// from migrations — see that file for the safety model) and then applies `seeds/seed.sql` in-process.
// By default you must type the project ref to confirm (drop.mjs's interactive gate); pass --force to
// skip it. The `--test` flag retargets every step at TEST_DATABASE_URL by overriding DATABASE_URL for
// the child (dotenv won't clobber an already-set env var), so it can never touch the dev DB.
//
// NOTE: this seeds the DB-level fixtures only (seed.sql: tenant rows + trigger/RPC asserts). The demo
// CONTENT posts (`seed-*-post.mjs`) need a running server and live behind `pnpm seed` — not here.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const isTest = args.has("--test");
const force = args.has("--force") || args.has("-f");

const urlVar = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
const url = process.env[urlVar];
if (!url) {
  console.error(`✗ ${urlVar} required in .env`);
  process.exit(1);
}

console.log(`🌱 genesis → ${isTest ? "TEST" : "DEV"} (${urlVar})\n`);

// ── 1. drop + rebuild from migrations (delegated to the hardened drop.mjs) ──────
// drop.mjs reads DATABASE_URL; we force it to the chosen target. `import "dotenv/config"` in the child
// won't override an env var that's already set, so this override wins even though .env defines both.
const dropArgs = ["--yes", "--migrate", ...(force ? ["--force"] : [])];
const drop = spawnSync(process.execPath, [join(here, "drop.mjs"), ...dropArgs], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});
if (drop.status !== 0) {
  console.error("\n✗ genesis aborted at drop/migrate (nothing seeded).");
  process.exit(drop.status ?? 1);
}

// ── 2. seed fixtures + validate triggers/RPC (seed.sql, in-process) ─────────────
// seed.sql is pure SQL except a single trailing `\echo` (a psql meta-command). Strip backslash lines
// and run via the simple protocol (required for the multi-statement begin/…/commit script). Any failed
// ASSERT aborts the transaction → the query rejects → we surface it. On success we print the ✅.
const seedSql = readFileSync(join(here, "seeds", "seed.sql"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*\\/.test(line))
  .join("\n");

const sql = postgres(url, { max: 1, prepare: false, onnotice() {} });
try {
  await sql.unsafe(seedSql).simple();
  console.log("\n✅ genesis complete — schema rebuilt, fixtures seeded, triggers + RPC validated.");
} catch (err) {
  console.error("\n✗ seed.sql failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
