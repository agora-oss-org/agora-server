// 🌱 GENESIS — from nothing to a valid, seeded schema in one command.
//   Drop the schema → rebuild from migrations (0000…N) → seed fixtures + validate triggers/RPC →
//   empty the social graph (Neo4j) so it can't desync from the freshly-rebuilt Postgres.
//
//   node scripts/genesis.mjs                    # → DATABASE_URL
//   node scripts/genesis.mjs --test             # → TEST_DATABASE_URL (disposable test project; non-interactive)
//   node scripts/genesis.mjs --force            # skip the prompt — LOCAL non-prod throwaway only
//   node scripts/genesis.mjs --project <uuid>   # seed THIS project id instead of the default 1111…1111
//                                               # (also honors the PROJECT_ID env the seed-* scripts use;
//                                               #  the flag wins. The rebuilt DB contains ONLY this project —
//                                               #  genesis is from-nothing, it does not ADD a second project.)
//
// DESTRUCTIVE. This wraps `drop.mjs --yes --migrate` (which drops private/drizzle/public and rebuilds
// from migrations — see that file for the safety model) and then applies `seeds/seed.sql` in-process.
// The drop.mjs guard (DATABASE_URL host + AGORA_ENV) decides the confirm: a LOCAL non-prod throwaway may
// be forced with --force; a PROTECTED target (cloud/remote host, or AGORA_ENV=prod even on a local db)
// ignores --force and requires the typed-ref confirm. The `--test` flag retargets every step at
// TEST_DATABASE_URL and passes the sole non-interactive exception (AGORA_TEST_DROP) to drop, so it never
// touches the dev DB and stays non-interactive in CI.
//
// NOTE: this seeds the DB-level fixtures only (seed.sql: tenant rows + trigger/RPC asserts). The demo
// CONTENT posts (`seed-*-post.mjs`) need a running server and live behind `pnpm seed` — not here.
//
// NEO4J: when NEO4J_URI is set, the final step resets the social-graph database (NEO4J_DATABASE ??
// "neo4j") so stale INTERACTED/FOLLOWS/… edges can't outlive the Postgres rows they mirror. Strategy is
// chosen by the db's ROLE (not its name): a SECONDARY db gets a true DROP + CREATE DATABASE (from-nothing
// — also clears constraints/indexes, which the scorer recreates on startup); the DEFAULT/HOME db is
// emptied in place with DETACH DELETE (constraints kept) because recreating the home db at runtime on
// DozerDB strands it "unknown" until a server restart. A non-empty graph is CONFIRMED first — type the
// "host/db" graph ref, exactly like drop.mjs's Postgres gate (Neo4j is a separate datastore, often a
// different host); --force skips the prompt, a non-interactive run without --force refuses, and declining
// leaves the graph intact. It is DEV-ONLY (skipped under --test, whose env has no dedicated graph and
// would otherwise wipe the shared dev graph) and BEST-EFFORT (a down/unreachable Neo4j warns but does NOT
// fail genesis — the schema rebuild is the core contract; the graph is optional).
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const args = new Set(argv);
const isTest = args.has("--test");
const force = args.has("--force") || args.has("-f");

// The default fixture project id, as written in seeds/seed.sql. Every occurrence of THIS uuid in
// seed.sql is the project id (other fixture uuids all differ in their leading byte), so a targeted
// textual substitution retargets the whole seed at another project. --project wins over the
// PROJECT_ID env (the same var the seed-*/03-seed-engine content scripts honor downstream).
const DEFAULT_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const projectId = (readProjectArg() ?? process.env.PROJECT_ID ?? DEFAULT_PROJECT_ID).toLowerCase();

// Strict uuid check — this value is substituted into SQL text before execution, so the regex is the
// injection guard, exactly like isDroppableDatabase()'s DB_NAME_RE for the Neo4j DDL below.
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)) {
  console.error(`✗ --project must be a UUID, got: ${projectId}`);
  process.exit(1);
}

function readProjectArg() {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        console.error("✗ --project requires a value (a project UUID)");
        process.exit(1);
      }
      return argv[i + 1];
    }
    if (argv[i].startsWith("--project=")) return argv[i].slice("--project=".length);
  }
  return null;
}

const urlVar = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
const url = process.env[urlVar];
if (!url) {
  console.error(`✗ ${urlVar} required in .env`);
  process.exit(1);
}

// Resolve the exact target from the URL so the operator sees WHICH database will be dropped + rebuilt
// BEFORE anything runs — never print credentials, only host:port/dbname.
const target = describeTarget(url);

console.log(`🌱 genesis → ${isTest ? "TEST" : "DEV"} (${urlVar})`);
console.log(`   target : ${target.host}${target.database ? `/${target.database}` : ""}`);
console.log(`   project : ${projectId}${projectId === DEFAULT_PROJECT_ID ? "" : "  (⚠ non-default — the rebuilt DB contains ONLY this project)"}`);
console.log(`   AGORA_ENV : ${process.env.AGORA_ENV ?? "(unset)"}\n`);

function describeTarget(u) {
  try {
    const parsed = new URL(u);
    return { host: parsed.host || "(no host)", database: decodeURIComponent(parsed.pathname).replace(/^\//, "") };
  } catch {
    return { host: "(unparseable " + urlVar + ")", database: "" };
  }
}

// ── 1. drop + rebuild from migrations (delegated to the hardened drop.mjs) ──────
// drop.mjs reads DATABASE_URL; we force it to the chosen target. `import "dotenv/config"` in the child
// won't override an env var that's already set, so this override wins even though .env defines both.
// `--test` targets the disposable TEST_DATABASE_URL — set AGORA_TEST_DROP=1 so drop.mjs allows the
// (protected, cloud) test DB to be rebuilt non-interactively. This is the ONLY non-interactive bypass of
// the protected-target guard; a normal `--force` only skips the prompt for a LOCAL non-prod throwaway.
const dropArgs = ["--yes", "--migrate", ...(force ? ["--force"] : [])];
const drop = spawnSync(process.execPath, [join(here, "drop.mjs"), ...dropArgs], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url, ...(isTest ? { AGORA_TEST_DROP: "1" } : {}) },
});
if (drop.status !== 0) {
  console.error("\n✗ genesis aborted at drop/migrate (nothing seeded).");
  process.exit(drop.status ?? 1);
}

// ── 2. seed fixtures + validate triggers/RPC (seed.sql, in-process) ─────────────
// seed.sql is pure SQL except a single trailing `\echo` (a psql meta-command). Strip backslash lines
// and run via the simple protocol (required for the multi-statement begin/…/commit script). Any failed
// ASSERT aborts the transaction → the query rejects → we surface it. On success we print the ✅.
let seedSql = readFileSync(join(here, "seeds", "seed.sql"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*\\/.test(line))
  .join("\n");

// Retarget the seed at the requested project. Guard first: if the requested id already appears in
// seed.sql as some OTHER fixture (profile/entity/space/… uuid), the substitution would silently
// collide two fixtures — refuse rather than seed a corrupted world.
if (projectId !== DEFAULT_PROJECT_ID) {
  if (seedSql.includes(projectId)) {
    console.error(`✗ --project ${projectId} collides with a non-project fixture uuid in seeds/seed.sql — pick another id.`);
    process.exit(1);
  }
  seedSql = seedSql.replaceAll(DEFAULT_PROJECT_ID, projectId);
}

// Identity backend for the seeded project. A Supabase-less (self-contained) deploy sets
// DEFAULT_AUTH_PROVIDER=native so the fixture project uses the in-API password backend out of the box;
// otherwise it stays the column default ('supabase'). An existing project switches later via admin
// settings / SQL — getAuthProvider() reads projects.auth_provider, never the env.
const authProvider = process.env.DEFAULT_AUTH_PROVIDER === "native" ? "native" : "supabase";

const sql = postgres(url, { max: 1, prepare: false, onnotice() {} });
try {
  await sql.unsafe(seedSql).simple();
  await sql`update projects set auth_provider = ${authProvider}::auth_provider where id = ${projectId}`;
  console.log(`\n✅ genesis complete — schema rebuilt, project ${projectId} seeded (auth_provider=${authProvider}), triggers + RPC validated.`);
} catch (err) {
  console.error("\n✗ seed.sql failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}

// ── 3. empty the social graph (Neo4j/DozerDB) so it can't desync from the rebuilt Postgres ──────
// Genesis means "from nothing": a fresh Postgres schema with stale graph edges would leave /social/*
// reading INTERACTED/FOLLOWS/… relationships whose rows no longer exist. See the NEO4J note in the
// header for the scope (dev-only, best-effort). Parse NEO4J_AUTH exactly like lib/neo4j.ts.
await wipeNeo4jIfConfigured();

async function wipeNeo4jIfConfigured() {
  const neoUri = process.env.NEO4J_URI;
  if (!neoUri) {
    console.log("○ neo4j: NEO4J_URI unset — social graph not configured, skipping graph wipe.");
    return;
  }
  if (isTest) {
    console.log("○ neo4j: --test run — leaving the (shared dev) graph untouched, skipping graph wipe.");
    return;
  }

  const database = process.env.NEO4J_DATABASE || "neo4j";
  let neoHost = neoUri;
  try { neoHost = new URL(neoUri).host || neoUri; } catch { /* keep the raw URI as the label */ }
  const neoTarget = `${neoHost}/${database}`; // host + db, shown in every operator-facing message
  console.log(`\n🌐 neo4j → social graph target  ${neoTarget}`);

  const [neoUser, ...rest] = (process.env.NEO4J_AUTH ?? "neo4j/").split("/");
  const neoPassword = rest.join("/"); // preserve any slashes in the password

  let neo4j;
  try {
    ({ default: neo4j } = await import("neo4j-driver"));
  } catch {
    console.warn("⚠️  neo4j: neo4j-driver not installed — cannot empty the graph (skipped).");
    return;
  }

  const neoDriver = neo4j.driver(neoUri, neo4j.auth.basic(neoUser, neoPassword), {
    connectionAcquisitionTimeout: 5_000, // fail fast instead of hanging when Neo4j is down
  });
  const session = neoDriver.session({ database });
  try {
    // Node count doubles as an existence probe: a missing database (a valid DozerDB state — the graph db
    // need not exist yet) throws DatabaseNotFound, which we treat as "nothing to reset" (the scorer
    // creates it fresh on its next startup), not a failure.
    let nodes;
    try {
      const counted = await session.run("MATCH (n) RETURN count(n) AS c");
      const raw = counted.records[0]?.get("c");
      nodes = raw?.toNumber?.() ?? Number(raw ?? 0);
    } catch (err) {
      if (String(err?.code ?? "").includes("DatabaseNotFound")) {
        console.log(`○ neo4j: database "${database}" does not exist — nothing to reset (created fresh on scorer startup).`);
        return;
      }
      throw err;
    }

    if (nodes === 0) {
      console.log(`○ neo4j: ${neoTarget} is already empty — nothing to reset.`);
      return;
    }

    // Confirm before the IRREVERSIBLE reset — Neo4j is a SEPARATE datastore from the Postgres already
    // confirmed by drop.mjs (often a different host), so it gets its own type-the-ref gate. --force skips
    // the prompt (throwaway); a non-interactive run without --force refuses to reset the graph unattended.
    // Declining leaves the graph INTACT and does not fail genesis.
    if (!force) {
      if (!process.stdin.isTTY) {
        console.warn(`⚠️  neo4j: ${nodes} node(s) in ${neoTarget} left intact — refusing to reset the graph non-interactively.`);
        console.warn("   Re-run in a terminal to confirm, or pass --force to skip the prompt.");
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `⚠️  Reset the social graph — this clears all ${nodes} node(s) in ${neoTarget}. Type the graph ref "${neoTarget}" to confirm: `);
      rl.close();
      if (answer.trim() !== neoTarget) {
        console.log("○ neo4j: left the graph intact (ref not matched).");
        return;
      }
    }

    // Reset strategy is chosen by the database's ROLE, not its name. A SECONDARY database gets a true
    // DROP + CREATE (from-nothing — clears data AND constraints/indexes/GDS state; the scorer recreates
    // constraints on its next startup). The DEFAULT/HOME database is emptied in place with DETACH DELETE
    // instead: recreating the home db at runtime on DozerDB strands it in currentStatus:"unknown" until a
    // server restart (observed), so we NEVER DROP it. Fail-safe: if the role can't be determined (no
    // access to `system`, older build), isDroppableDatabase() returns false → DETACH DELETE.
    if (await isDroppableDatabase(neoDriver, database)) {
      // CREATE/DROP DATABASE take no bound parameter for the name (validated in isDroppableDatabase) and
      // this DozerDB build rejects `WAIT`, so run the DDL against `system`, then poll SHOW DATABASE until
      // the recreated db is back online before returning.
      const sys = neoDriver.session({ database: "system" });
      try {
        await sys.run(`DROP DATABASE \`${database}\` IF EXISTS`);
        await sys.run(`CREATE DATABASE \`${database}\``);
      } finally {
        await sys.close().catch(() => {});
      }
      await waitDatabaseOnline(neoDriver, database);
      console.log(`✅ neo4j: recreated ${neoTarget} (dropped + created empty — ${nodes} node${nodes === 1 ? "" : "s"} cleared).`);
    } else {
      // Home/default (or undeterminable) db → empty in place. Batched IN TRANSACTIONS so a large graph
      // doesn't exhaust the transaction heap; runs in the implicit auto-commit tx. Constraints kept.
      await session.run("CALL { MATCH (n) DETACH DELETE n } IN TRANSACTIONS OF 10000 ROWS");
      console.log(`✅ neo4j: emptied ${neoTarget} (${nodes} node${nodes === 1 ? "" : "s"} removed; constraints kept).`);
    }
  } catch (err) {
    console.warn(`⚠️  neo4j: could not reset ${neoTarget} — ${err.message}`);
    console.warn("   (schema rebuild succeeded; the social graph was NOT cleared and may desync — clear it once Neo4j is reachable.)");
  } finally {
    // The target-db session may have had its database dropped out from under it — closing it can error;
    // guard so it never masks the driver close or fails genesis.
    await session.close().catch(() => {});
    await neoDriver.close().catch(() => {});
  }
}

// A database is safe to DROP + CREATE only if it's a SECONDARY db: NOT the default/home db (recreating
// the home db at runtime strands it in currentStatus:"unknown" until a server restart — observed) and NOT
// `system`, with a name that passes DozerDB's rules (the regex IS the injection guard for the DDL that
// interpolates the name — mirrors services/scorer's valid_db_name). The role comes from `system`; if that
// read fails (no access / older build / db not listed) it returns false so the caller falls back to the
// always-safe DETACH DELETE. Fail-safe by construction: an undeterminable role is treated as NOT droppable.
async function isDroppableDatabase(driver, database) {
  const DB_NAME_RE = /^[a-z][a-z0-9.-]{2,62}$/; // DozerDB naming — mirror of the scorer's valid_db_name
  if (database === "system" || !DB_NAME_RE.test(database)) return false;
  const sys = driver.session({ database: "system" });
  try {
    const r = await sys.run(`SHOW DATABASE \`${database}\``);
    const rec = r.records[0];
    if (!rec) return false; // not listed → don't attempt a DROP
    return rec.get("home") !== true && rec.get("default") !== true;
  } catch {
    return false; // can't determine the role → fall back to DETACH DELETE
  } finally {
    await sys.close().catch(() => {});
  }
}

// Poll SHOW DATABASE until a freshly-(re)created DozerDB database reports online. CREATE DATABASE is
// asynchronous on this build (it rejects the `WAIT` keyword), so a session opened too early would hit a
// not-yet-online database. `database` is already name-validated by the caller before it reaches here.
async function waitDatabaseOnline(driver, database, { tries = 50, everyMs = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const sys = driver.session({ database: "system" });
    try {
      const r = await sys.run(`SHOW DATABASE \`${database}\` YIELD currentStatus`);
      if (r.records[0]?.get("currentStatus") === "online") return;
    } finally {
      await sys.close().catch(() => {});
    }
    await new Promise((res) => setTimeout(res, everyMs));
  }
  throw new Error(`database "${database}" did not come online after ${(tries * everyMs) / 1000}s`);
}
