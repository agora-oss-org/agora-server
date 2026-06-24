// Deterministic perf fixture seeder for the load-test harness (perf/README.md).
//
// Bulk-inserts a DEDICATED, isolated dataset (its own throwaway project_id) straight into Postgres —
// profiles + entities + comment threads — then mints a pool of HS256 access tokens (sub = profile id,
// exactly the path requireAuth verifies; no Supabase Auth user needed, same trick as ws-verify.mjs).
// Writes everything k6 needs to perf/.fixture.json.
//
// IDEMPOTENT + REPRODUCIBLE: deletes any prior perf project (by client_id) and rebuilds from scratch,
// so every baseline run starts from a byte-identical corpus — the whole point of a low-variance baseline.
//
// Reads DATABASE_URL + ACCESS_TOKEN_SECRET from the env (apps/api/.env via dotenv). Point them at the
// SAME stack the API under test uses (for the canonical baseline: the local self-host docker stack).
//
//   node perf/seed-perf-data.mjs
//   PERF_ENTITIES=1000 PERF_USERS=50 node perf/seed-perf-data.mjs
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { SignJWT } from "jose";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, ".fixture.json");

const DB_URL = process.env.DATABASE_URL;
const SECRET = process.env.ACCESS_TOKEN_SECRET;
if (!DB_URL) die("DATABASE_URL is not set (load apps/api/.env).");
if (!SECRET) die("ACCESS_TOKEN_SECRET is not set (load apps/api/.env).");

// Tunables — keep defaults modest so a re-seed is fast; bump for a heavier corpus.
const CLIENT_ID = process.env.PERF_CLIENT_ID || "agora-perf-loadtest";
const BASE_URL = (process.env.PERF_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
const N_USERS = int(process.env.PERF_USERS, 20);
const N_ENTITIES = int(process.env.PERF_ENTITIES, 300);
const N_THREAD_ENTITIES = int(process.env.PERF_THREAD_ENTITIES, 30); // entities that get a comment thread
const ROOTS_PER_THREAD = int(process.env.PERF_ROOTS_PER_THREAD, 15);
const REPLIES_PER_THREAD = int(process.env.PERF_REPLIES_PER_THREAD, 20);
const TOKEN_TTL = process.env.PERF_TOKEN_TTL || "24h"; // re-seed to refresh

const sql = postgres(DB_URL, { prepare: false, max: 4 });

// Deterministic-ish picker without Math.random dependence on the row content (fine for seeding).
const pick = (arr, i) => arr[i % arr.length];

try {
  console.log(`▶ seeding perf fixture → ${CLIENT_ID}`);
  console.log(`  users=${N_USERS} entities=${N_ENTITIES} threadEntities=${N_THREAD_ENTITIES}`);

  // 1. Clean slate — drop any prior perf project (cascades to all its content), recreate.
  await sql`delete from projects where client_id = ${CLIENT_ID}`;
  const projectId = randomUUID();
  await sql`insert into projects (id, client_id, name, auth_provider)
            values (${projectId}, ${CLIENT_ID}, ${"Agora perf load-test"}, ${"native"})`;

  // 2. Users (profiles). Explicit ids so we can mint tokens without RETURNING round-trips.
  const userIds = Array.from({ length: N_USERS }, () => randomUUID());
  const profileRows = userIds.map((id, i) => ({
    id,
    project_id: projectId,
    role: "visitor",
    username: `perf_u${i}_${id.slice(0, 6)}`,
    name: `Perf User ${i}`,
    email: `perf+${i}@loadtest.local`,
  }));
  await insertChunked(profileRows, (rows) =>
    sql`insert into profiles ${sql(rows, "id", "project_id", "role", "username", "name", "email")}`);

  // 3. Entities — each owned by a rotating user. short_id unique per project (required, notNull).
  const entityIds = Array.from({ length: N_ENTITIES }, () => randomUUID());
  const entityRows = entityIds.map((id, i) => ({
    id,
    project_id: projectId,
    short_id: `perf-${i}-${id.slice(0, 8)}`,
    user_id: pick(userIds, i),
    title: `Perf entity ${i}`,
    content: `Load-test seed body for entity ${i}. ` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.",
  }));
  await insertChunked(entityRows, (rows) =>
    sql`insert into entities ${sql(rows, "id", "project_id", "short_id", "user_id", "title", "content")}`);

  // 4. Comment threads on a subset (so /comments + /comments/thread read real volume). Roots first,
  //    then replies pointing at random roots → multi-level tree for fetch_comment_thread to recurse.
  const threadEntityIds = entityIds.slice(0, Math.min(N_THREAD_ENTITIES, entityIds.length));
  const commentRows = [];
  let c = 0;
  for (const entityId of threadEntityIds) {
    const roots = [];
    for (let r = 0; r < ROOTS_PER_THREAD; r++) {
      const id = randomUUID();
      roots.push(id);
      commentRows.push({
        id, project_id: projectId, entity_id: entityId, user_id: pick(userIds, c++),
        parent_id: null, content: `Root comment ${r} on perf thread.`,
      });
    }
    for (let r = 0; r < REPLIES_PER_THREAD; r++) {
      commentRows.push({
        id: randomUUID(), project_id: projectId, entity_id: entityId, user_id: pick(userIds, c++),
        parent_id: pick(roots, r), content: `Reply ${r} nested under a root comment.`,
      });
    }
  }
  await insertChunked(commentRows, (rows) =>
    sql`insert into comments ${sql(rows, "id", "project_id", "entity_id", "user_id", "parent_id", "content")}`);

  // 5. Mint one access token per user (HS256 over ACCESS_TOKEN_SECRET, sub = profile id).
  const key = new TextEncoder().encode(SECRET);
  const tokens = await Promise.all(userIds.map((id) =>
    new SignJWT({ role: "visitor", operator: false, steward: false })
      .setProtectedHeader({ alg: "HS256" }).setSubject(id).setExpirationTime(TOKEN_TTL).sign(key)));

  const fixture = { baseUrl: BASE_URL, projectId, tokens, entityIds, threadEntityIds };
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2));

  console.log(`✅ seeded: ${N_USERS} users, ${N_ENTITIES} entities, ${commentRows.length} comments`);
  console.log(`   project_id : ${projectId}`);
  console.log(`   fixture    : ${FIXTURE_PATH}`);
  console.log(`   tokens TTL : ${TOKEN_TTL} (re-seed to refresh)`);
} finally {
  await sql.end();
}

// postgres.js caps bind params; chunk large inserts so we never blow the limit.
async function insertChunked(rows, run, size = 500) {
  for (let i = 0; i < rows.length; i += size) await run(rows.slice(i, i + size));
}

function int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
