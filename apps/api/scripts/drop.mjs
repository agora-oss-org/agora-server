// ⚠️  DESTRUCTIVE — drops the Agora SCHEMA (not just the data) so it can be rebuilt from migrations.
//
// Where `wipe.mjs` TRUNCATEs rows but keeps the tables, this nukes the schema OBJECTS themselves:
//   • DROP SCHEMA private CASCADE  — the SECURITY DEFINER helpers (migration 0017).
//   • DROP SCHEMA public  CASCADE  — every table, enum, function, trigger, AND the public-installed
//                                     extensions (pgcrypto/vector/postgis). `migrate.mjs` recreates
//                                     all of it from 0000.
//   • DROP SCHEMA drizzle CASCADE  — the `drizzle.__drizzle_migrations` ledger (drizzle-orm's DEFAULT
//                                     migrationsSchema — NOT public). MUST be dropped too: a surviving
//                                     ledger makes the subsequent migrate a silent no-op against the
//                                     emptied schema, leaving an empty DB that *looks* fully migrated.
//   • CREATE SCHEMA public + restore the baseline Supabase schema grants, so the migrations'
//     per-table `GRANT … TO anon, authenticated` (0008/0017) land on a reachable schema.
//
// What it does NOT touch:
//   • `auth` (Supabase-managed). `profiles.auth_user_id` is a plain uuid with no FK, so dropping
//     `public` never cascades into auth — Auth users survive. Delete those with `wipe.mjs --yes`
//     (admin API) if you want a TOTAL reset. Storage objects likewise are `wipe.mjs`'s domain.
//
// Safety (mirrors wipe.mjs):
//   • DRY RUN by default — prints the target + what WOULD be dropped, changes nothing.
//   • Pass --yes to actually execute. Then the confirmation depends on the TARGET:
//       – LOCAL throwaway (DATABASE_URL host is db/localhost/127.0.0.1, and AGORA_ENV≠prod):
//         `--force` drops it unattended (no prompt). This is the common dev/selfhost case.
//       – PROTECTED (any cloud/remote host, OR AGORA_ENV=prod even on a local db): `--force` does NOT
//         skip the guard — you type the project ref to confirm. Non-interactively it refuses (the one
//         sanctioned exception is `genesis --test`, which targets the disposable TEST_DATABASE_URL).
//   • Target is derived from DATABASE_URL + AGORA_ENV in your .env — double-check it.
//
// Usage:
//   node scripts/drop.mjs                  # dry run (safe) — lists objects that would be dropped
//   node scripts/drop.mjs --yes            # drop schema (typed-ref confirm on a protected target)
//   node scripts/drop.mjs --yes --force    # skip the prompt — LOCAL non-prod throwaway only
//   node scripts/drop.mjs --yes --migrate  # drop, then immediately rebuild from migrations
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { isProtectedTarget } from "./lib/db-target.mjs";

// ── args ──────────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const EXECUTE = args.has("--yes") || args.has("-y");
const FORCE = args.has("--force");
// A protected target needs the typed-ref confirm. `genesis --test` (disposable TEST_DATABASE_URL) sets
// AGORA_TEST_DROP=1 for this child so CI can rebuild the test DB non-interactively — the ONLY bypass;
// there is deliberately no user-facing "force a protected target" flag.
const TEST_BYPASS = process.env.AGORA_TEST_DROP === "1";
const PROTECTED = isProtectedTarget({ agoraEnv: process.env.AGORA_ENV, databaseUrl: process.env.DATABASE_URL });
const RUN_MIGRATE = args.has("--migrate");

// Schemas this app owns end-to-end: migrations create `public` + the `drizzle` ledger; 0017 creates
// `private`. The ledger MUST be dropped alongside public or the rebuild no-ops. `auth` is intentionally absent.
const SCHEMAS = ["private", "drizzle", "public"];

// ── env / target ──────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) die("DATABASE_URL required (.env).");
const dbHost = safeHost(dbUrl);
const ref = projectRef(dbUrl);

console.log("⚠️  Agora DROP SCHEMA");
console.log(`   DB target    : ${dbHost}`);
console.log(`   Project ref  : ${ref}`);
console.log(`   Schemas      : ${SCHEMAS.join(", ")}  (DROP … CASCADE, then recreate empty public)`);
console.log(`   Preserves    : auth schema + Auth users + Storage (use wipe.mjs for those)`);
console.log(`   AGORA_ENV    : ${process.env.AGORA_ENV ?? "(unset)"}`);
console.log(`   Target kind  : ${PROTECTED ? "PROTECTED (cloud/remote or AGORA_ENV=prod — confirm required)" : "LOCAL throwaway (--force may drop unattended)"}`);
console.log("");

const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice() {} });

try {
  // ── DRY RUN: report what's there, change nothing ────────────────────────────
  if (!EXECUTE) {
    console.log("DRY RUN (no --yes) — nothing will be dropped.\n");
    for (const schema of SCHEMAS) {
      const [{ tables }] = await sql`
        select count(*)::int as tables from information_schema.tables
        where table_schema = ${schema} and table_type = 'BASE TABLE'`;
      const [{ routines }] = await sql`
        select count(*)::int as routines from information_schema.routines where routine_schema = ${schema}`;
      const [{ types }] = await sql`
        select count(*)::int as types from pg_type t
        join pg_namespace n on n.oid = t.typnamespace where n.nspname = ${schema} and t.typtype = 'e'`;
      console.log(`   ${schema}: ${tables} tables, ${routines} functions, ${types} enums`);
    }
    console.log("\nRe-run with --yes to execute (add --migrate to rebuild immediately).");
    process.exit(0);
  }

  // ── confirmation gate ────────────────────────────────────────────────────────
  // PROTECTED target (cloud/remote host, or AGORA_ENV=prod even on a local db): --force can NOT skip
  // the guard — type the project ref to confirm; non-interactively refuse (except the sanctioned
  // `genesis --test` bypass). LOCAL non-prod throwaway: --force drops it unattended. This is what
  // closes the "genesis --force against a real DB" footgun while keeping the dev/selfhost path frictionless.
  if (PROTECTED) {
    if (!TEST_BYPASS) {
      if (process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(
          `⚠️  PROTECTED target (${dbHost}, AGORA_ENV=${process.env.AGORA_ENV ?? "unset"}). ` +
          `Type the project ref "${ref}" to confirm IRREVERSIBLE drop: `);
        rl.close();
        if (answer.trim() !== ref) die("Confirmation did not match — aborted. Nothing was dropped.");
      } else {
        die(`Refusing to drop a PROTECTED target (${dbHost}, AGORA_ENV=${process.env.AGORA_ENV ?? "unset"}) non-interactively. ` +
          "Run it in a terminal and type the project ref — `--force` does not skip this. " +
          "(CI resetting the disposable test DB: use `genesis --test`.)");
      }
    }
  } else if (!FORCE) {
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Type the project ref "${ref}" to confirm IRREVERSIBLE drop: `);
      rl.close();
      if (answer.trim() !== ref) die("Confirmation did not match — aborted. Nothing was dropped.");
    } else {
      die("Refusing non-interactive drop without --force. Re-run with --yes --force.");
    }
  }

  // ── drop + recreate (atomic) ──────────────────────────────────────────────────
  // One transaction: if any step fails, the schema is left intact rather than half-dropped.
  await sql.begin((tx) => [
    tx`drop schema if exists private cascade`,
    // The drizzle-orm migration ledger lives here (default migrationsSchema). Dropping it resets the
    // high-water mark so the follow-up migrate actually re-applies 0000…N instead of no-opping.
    tx`drop schema if exists drizzle cascade`,
    tx`drop schema if exists public cascade`,
    tx`create schema public`,
    // Baseline Supabase schema grants (a fresh project ships these). Per-table grants live in the
    // migrations; these just make the schema reachable for the anon/authenticated roles.
    tx`grant usage on schema public to anon, authenticated, service_role`,
    tx`grant all on schema public to postgres, service_role`,
  ]);
  console.log("✓ dropped private + drizzle + public; recreated empty public with baseline grants");

  // ── optional rebuild ──────────────────────────────────────────────────────────
  if (RUN_MIGRATE) {
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    console.log("✓ migrations applied — schema rebuilt from 0000");
  } else {
    console.log("\nNext: rebuild the schema →  node scripts/migrate.mjs");
    console.log("Then re-seed tenant rows →  psql \"$DATABASE_URL\" -f scripts/seeds/seed.sql");
  }

  console.log("\n✅ drop complete.");
} finally {
  await sql.end();
}
process.exit(0);

// ── helpers ─────────────────────────────────────────────────────────────────
function safeHost(url) {
  try { return new URL(url).host; } catch { return "(unparseable DATABASE_URL)"; }
}
// `host/dbname` — the local-db confirm token, so the operator disambiguates WHICH database on a host
// that may serve several (e.g. `localhost:5432/postgres` vs `.../agora_test`).
function safeHostDb(url) {
  try {
    const u = new URL(url);
    const db = decodeURIComponent(u.pathname).replace(/^\//, "");
    return db ? `${u.host}/${db}` : u.host;
  } catch { return "(unparseable DATABASE_URL)"; }
}
// Supabase pooler users are `postgres.<projectref>`; fall back to SUPABASE_URL's first host label,
// then the DB host/dbname — whatever yields a stable string for the type-to-confirm gate.
function projectRef(url) {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    if (user.startsWith("postgres.")) return user.slice("postgres.".length);
  } catch { /* fall through */ }
  if (process.env.SUPABASE_URL) {
    try { return new URL(process.env.SUPABASE_URL).host.split(".")[0]; } catch { /* fall through */ }
  }
  return safeHostDb(url);
}
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
