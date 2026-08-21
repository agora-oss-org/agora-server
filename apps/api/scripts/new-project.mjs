// 🌿 NEW PROJECT — ADDITIVE tenant creation in a LIVE database. The non-destructive sibling of
//   genesis.mjs: inserts ONE `projects` row (plus nothing else) so a new project can live alongside
//   the ones the DB already holds. No schema drop, no migrations, no seed.sql fixtures (those carry
//   globally-fixed uuids owned by the genesis world), no Neo4j touch.
//
//   node scripts/new-project.mjs --project <uuid>                 # required (or PROJECT_ID env)
//   node scripts/new-project.mjs --project <uuid> --name "My Community" --client-id my-client
//
// After the row exists, seed the admin login + demo content THROUGH the running API (the content
// seeders are all PROJECT_ID-aware; the auth-admin helpers honor ADMIN_PROJECT_ID ?? PROJECT_ID):
//
//   PROJECT_ID=<uuid> pnpm seed
//
// Idempotent: an existing project id is reported and left untouched (`on conflict do nothing` —
// we never clobber a live project's name/config/auth_provider).
import "dotenv/config";
import postgres from "postgres";

const argv = process.argv.slice(2);

function readArg(flag) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        console.error(`✗ ${flag} requires a value`);
        process.exit(1);
      }
      return argv[i + 1];
    }
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return null;
}

const projectId = (readArg("--project") ?? process.env.PROJECT_ID ?? "").toLowerCase();
if (!projectId) {
  console.error("✗ a project id is required: --project <uuid> (or the PROJECT_ID env)");
  process.exit(1);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)) {
  console.error(`✗ --project must be a UUID, got: ${projectId}`);
  process.exit(1);
}

const name = readArg("--name") ?? "Agora Project";
const clientId = readArg("--client-id") ?? "agora-client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL required in .env");
  process.exit(1);
}

// Same identity-backend default as genesis: a Supabase-less deploy sets DEFAULT_AUTH_PROVIDER=native.
// Applied only on CREATE — an existing project's auth_provider is never touched.
const authProvider = process.env.DEFAULT_AUTH_PROVIDER === "native" ? "native" : "supabase";

let host = "(unparseable DATABASE_URL)", database = "";
try {
  const parsed = new URL(url);
  host = parsed.host || "(no host)";
  database = decodeURIComponent(parsed.pathname).replace(/^\//, "");
} catch { /* keep the fallback label */ }

console.log(`🌿 new-project → ${host}${database ? `/${database}` : ""}  (additive — nothing is dropped)`);
console.log(`   project : ${projectId}`);
console.log(`   name    : ${name}   client_id: ${clientId}   auth_provider: ${authProvider}\n`);

const sql = postgres(url, { max: 1, prepare: false, onnotice() {} });
try {
  const inserted = await sql`
    insert into projects (id, client_id, name, auth_provider)
    values (${projectId}, ${clientId}, ${name}, ${authProvider}::auth_provider)
    on conflict (id) do nothing
    returning id`;
  if (inserted.length === 0) {
    const [existing] = await sql`select name, auth_provider from projects where id = ${projectId}`;
    console.log(`○ project ${projectId} already exists ("${existing.name}", auth_provider=${existing.auth_provider}) — left untouched.`);
  } else {
    console.log(`✅ project ${projectId} created.`);
    console.log(`\nNext — seed the admin login + demo content through the running API:`);
    console.log(`   PROJECT_ID=${projectId} pnpm seed`);
  }
} catch (err) {
  // relation-missing means the schema was never built — that IS a genesis job (fresh DB, nothing to preserve).
  if (err.code === "42P01") {
    console.error("✗ the `projects` table does not exist — this DB has no Agora schema yet. Run `pnpm genesis` for a from-nothing build.");
  } else {
    console.error(`✗ creating project failed: ${err.message}`);
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
