// Seed engine — reads a declarative manifest (seed.json) and creates the whole world it describes
// (users, roles, spaces, memberships, posts, comments, follows, connections, reactions) by driving the
// normal Agora HTTP API as each acting user. Run ONCE on a clean DB:
//   pnpm seed                                        # from apps/api — runs this inside the orchestrator
//   node scripts/seeds/03-seed-engine.mjs [path/to/manifest.json]   # standalone
//
// Design (kept deliberately simple — see the brainstorm that produced it):
//   • Groups are processed in a fixed DEPENDENCY ORDER so every reference resolves by construction:
//       users → roles → spaces → memberships → follows → posts → comments → connections → reactions
//     (roles straight after users: a project_roles grant is profile-keyed, and the profile only exists
//     once that user has signed in.)
//     (follows before posts is deliberate, not just dependency order — it means a post's author is
//     already followed by its seeded followers when the post is created, so the demo data reads as a
//     real social feed instead of posts predating the relationships that would surface them.)
//   • `realized` is a deep clone of the manifest, annotated IN MEMORY with the real id of each
//     created node as we go. It never touches disk. By the time an edge group runs, every node it
//     points at already carries a real UUID.
//   • References are bare handle strings; the FIELD NAME implies the namespace (author→users,
//     entity→posts, parent→comments). Reactions discriminate the target via on:{post|comment}.
//   • No idempotency / ledger: this is run-once-on-clean-DB seed data. Re-running on a dirty DB will
//     duplicate content (and reactions TOGGLE) — wipe first.
//
// Env: API_BASE_URL (default http://localhost:4000), PROJECT_ID (default 11111111-…), DATABASE_URL
//      (required — used to read the project's auth_provider and, on a native project, insert the
//      confirmed auth_credentials rows directly). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required
//      only when the project's auth_provider is 'supabase'.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { hash } from "@node-rs/argon2";

const here = dirname(fileURLToPath(import.meta.url));

// ── config ──────────────────────────────────────────────────────────────────
const BASE = (process.env.API_BASE_URL || "http://localhost:4000").replace(/\/$/, "").replace(/\/v7$/, "");
const PROJECT_ID = process.env.PROJECT_ID || "11111111-1111-1111-1111-111111111111";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MANIFEST_PATH = resolve(process.argv[2] ? process.argv[2] : join(here, "seed.json"));

// Project-scoped vs root URL (connections live at the /v7 root, project derived from the token).
const api = (path) => `${BASE}/v7/${PROJECT_ID}${path}`;
const root = (path) => `${BASE}/v7${path}`;

function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ── tiny HTTP helper ─────────────────────────────────────────────────────────
// Returns parsed JSON; throws a labelled Error (status + body) on a non-2xx response.
async function http(method, url, { token, json, form, label } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) {
    body = form; // FormData — let fetch set the multipart boundary
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${label ?? `${method} ${url}`} → ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return parsed;
}

// ── manifest + in-memory symbol table ────────────────────────────────────────
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const realized = structuredClone(manifest); // annotated in place as nodes are created

const DEFAULT_PASSWORD = manifest.meta?.defaultPassword || process.env.DEMO_PASSWORD || "DemoPass123!";

// Per-type handle → record index (records live inside `realized`, so annotating one annotates both).
const index = { users: new Map(), spaces: new Map(), posts: new Map(), comments: new Map() };
const tokens = new Map(); // user handle → access token

for (const group of Object.keys(index)) {
  for (const item of realized[group] ?? []) {
    if (!item.handle) die(`every ${group} item needs a "handle" (offending item: ${JSON.stringify(item)})`);
    if (index[group].has(item.handle)) die(`duplicate ${group} handle "${item.handle}"`);
    index[group].set(item.handle, item);
  }
}

// Resolve a handle reference into a real id; fail loudly on an unknown/uncreated handle.
function refId(group, handle, ctx) {
  if (handle == null) return undefined;
  const rec = index[group].get(handle);
  if (!rec) die(`${ctx}: references ${group} "${handle}" which is not defined in the manifest`);
  if (!rec.id) die(`${ctx}: ${group} "${handle}" has no id yet (dependency-order bug)`);
  return rec.id;
}
function tokenFor(handle, ctx) {
  const t = tokens.get(handle);
  if (!t) die(`${ctx}: no auth token for user "${handle}" (was the users phase run?)`);
  return t;
}

// ── phase banner ──────────────────────────────────────────────────────────────
function phase(name, n) {
  console.log(`\n── ${name} (${n}) ${"─".repeat(Math.max(0, 40 - name.length))}`);
}

// ── 1. users ──────────────────────────────────────────────────────────────────
// Ensure a pre-confirmed auth credential on whichever backend the project actually uses (native
// in-API argon2, or Supabase admin), then sign in via the API to materialise the profile + capture its
// id and token, then PATCH name/username/avatar/bio (best-effort). The DB is only ever used to read
// auth_provider and — on a native project — insert the confirmed auth_credentials row directly (the
// same thing helpers/seed-native-auth-admin.mjs does for the single admin user); everything else
// still goes through the normal HTTP API.
async function seedUsers() {
  const users = realized.users ?? [];
  phase("users", users.length);
  if (!process.env.DATABASE_URL) {
    die("users require DATABASE_URL in env (.env) to resolve the project's auth_provider.");
  }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice() {} });
  try {
    const [project] = await sql`select auth_provider from projects where id = ${PROJECT_ID}`;
    if (!project) die(`project ${PROJECT_ID} not found — run \`node scripts/genesis.mjs\` first (or set PROJECT_ID).`);
    const authProvider = project.auth_provider;

    let supabaseAdmin;
    if (authProvider === "supabase") {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        die("users require SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (.env) for a supabase-backed project.");
      }
      supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    } else if (authProvider !== "native") {
      die(`project ${PROJECT_ID} has unsupported auth_provider "${authProvider}" (expected native or supabase)`);
    }
    console.log(`  auth backend: ${authProvider}`);

    for (const u of users) {
      const password = u.password || DEFAULT_PASSWORD;
      const email = u.email.trim().toLowerCase();

      if (authProvider === "native") {
        // Confirmed credential, direct insert (mirrors seed-native-auth-admin.mjs). ON CONFLICT DO
        // NOTHING mirrors the Supabase branch's tolerance of an already-existing user below.
        const passwordHash = await hash(password); // argon2id PHC string — verifyPassword reads it back
        await sql`
          insert into auth_credentials (project_id, email, password_hash, email_confirmed_at)
          values (${PROJECT_ID}, ${email}, ${passwordHash}, now())
          on conflict (project_id, email) do nothing`;
      } else {
        // create (or accept already-exists)
        const { error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
        if (error && !/already|exist|registered/i.test(error.message)) {
          die(`createUser failed for ${email}: ${error.message}`);
        }
      }

      // sign in → profile id + token (also runs ensureProfile)
      const session = await http("POST", api("/auth/sign-in"), {
        json: { email, password }, label: `sign-in ${u.handle}`,
      });
      if (!session.accessToken || !session.user?.id) die(`sign-in for ${u.handle} returned no token/user id`);
      u.id = session.user.id;
      tokens.set(u.handle, session.accessToken);

      // set display fields (best-effort — a strict schema shouldn't abort the run)
      const patch = {};
      if (u.name !== undefined) patch.name = u.name;
      if (u.username !== undefined) patch.username = u.username;
      if (u.avatar !== undefined) patch.avatar = u.avatar;
      if (u.bio !== undefined) patch.bio = u.bio;
      if (Object.keys(patch).length) {
        try {
          await http("PATCH", api(`/users/${u.id}`), { token: session.accessToken, json: patch, label: `profile ${u.handle}` });
        } catch (e) {
          console.warn(`  ⚠ profile update for ${u.handle} skipped: ${e.message}`);
        }
      }
      console.log(`  ✓ ${u.handle.padEnd(6)} ${u.name ?? ""}  (${u.id})`);
    }
  } finally {
    await sql.end();
  }
}

// ── 1b. roles ────────────────────────────────────────────────────────────────
// Grant the per-project trust tier (project_roles: owner|admin|steward) to any manifest user carrying
// a `roles` array. Runs immediately after users because the grant is PROFILE-keyed and a profile only
// materialises on that first sign-in above.
//
// Written straight to the DB rather than through POST /roles on purpose: that route is owner-gated, and
// a freshly-seeded project has no owner yet to authorise the first grant — this is the bootstrap. The
// grant lands in the access JWT at mint/refresh, so it takes effect on the user's next token refresh
// (the token captured during seedUsers predates it — expected, not a bug).
// Idempotent via the project_roles_unique (project_id, profile_id, role) constraint.
const PROJECT_ROLES = ["owner", "admin", "steward"]; // keep in sync with the `project_role` pg enum

async function seedRoles() {
  const granted = (realized.users ?? []).filter((u) => u.roles?.length);
  phase("roles", granted.length);
  if (!granted.length) return;

  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice() {} });
  try {
    for (const u of granted) {
      if (!u.id) die(`user "${u.handle}": no profile id yet (dependency-order bug)`);
      for (const role of u.roles) {
        // Reject an unknown tier loudly — never coerce a typo into a silent non-grant (or an enum error).
        if (!PROJECT_ROLES.includes(role)) {
          die(`user "${u.handle}": unknown role "${role}" (expected ${PROJECT_ROLES.join(" | ")})`);
        }
        await sql`
          insert into project_roles (project_id, profile_id, role)
          values (${PROJECT_ID}, ${u.id}, ${role}::project_role)
          on conflict (project_id, profile_id, role) do nothing`;
        console.log(`  ✓ ${u.handle.padEnd(6)} ${role}`);
      }
    }
  } finally {
    await sql.end();
  }
}

// ── 2. spaces ───────────────────────────────────────────────────────────────
async function seedSpaces() {
  const spaces = realized.spaces ?? [];
  phase("spaces", spaces.length);
  for (const s of spaces) {
    const token = tokenFor(s.owner, `space "${s.handle}"`);
    const body = {
      name: s.name,
      ...(s.slug !== undefined ? { slug: s.slug } : {}),
      ...(s.description !== undefined ? { description: s.description } : {}),
      ...(s.readingPermission !== undefined ? { readingPermission: s.readingPermission } : {}),
      ...(s.postingPermission !== undefined ? { postingPermission: s.postingPermission } : {}),
      ...(s.requireJoinApproval !== undefined ? { requireJoinApproval: s.requireJoinApproval } : {}),
      ...(s.parent !== undefined ? { parentSpaceId: refId("spaces", s.parent, `space "${s.handle}"`) } : {}),
    };
    const created = await http("POST", api("/spaces"), { token, json: body, label: `space ${s.handle}` });
    s.id = created.id;
    console.log(`  ✓ ${s.handle.padEnd(12)} "${s.name}"  (${s.id})  owner=${s.owner}`);
  }
}

// ── 3. memberships ────────────────────────────────────────────────────────────
// MVP: a plain join (→ role "member"). The space owner is already admin via creation.
async function seedMemberships() {
  const ms = realized.memberships ?? [];
  phase("memberships", ms.length);
  for (const m of ms) {
    const ctx = `membership ${m.user}→${m.space}`;
    const token = tokenFor(m.user, ctx);
    const spaceId = refId("spaces", m.space, ctx);
    await http("POST", api(`/spaces/${spaceId}/join`), { token, json: {}, label: ctx });
    console.log(`  ✓ ${m.user.padEnd(6)} joined ${m.space}`);
  }
}

// ── 4. follows ────────────────────────────────────────────────────────────────
async function seedFollows() {
  const follows = realized.follows ?? [];
  phase("follows", follows.length);
  for (const f of follows) {
    const ctx = `follow ${f.follower}→${f.following}`;
    const token = tokenFor(f.follower, ctx);
    const followedId = refId("users", f.following, ctx);
    await http("POST", api(`/users/${followedId}/follow`), { token, json: {}, label: ctx });
    console.log(`  ✓ ${f.follower.padEnd(6)} → ${f.following}`);
  }
}

// ── 5. posts ────────────────────────────────────────────────────────────────
async function seedPosts() {
  const posts = realized.posts ?? [];
  phase("posts", posts.length);
  for (const p of posts) {
    const ctx = `post "${p.handle}"`;
    const token = tokenFor(p.author, ctx);
    const spaceId = p.space !== undefined ? refId("spaces", p.space, ctx) : undefined;

    let created;
    if (p.image) {
      // multipart → server runs the image through sharp → Storage → files row (the SDK's path).
      const img = await fetch(p.image, { headers: { "User-Agent": "AgoraSeed/1.0" } });
      if (!img.ok) die(`${ctx}: image fetch failed (${img.status}) for ${p.image}`);
      const contentType = img.headers.get("content-type") || "image/jpeg";
      const bytes = new Uint8Array(await img.arrayBuffer());
      const form = new FormData();
      if (p.title !== undefined) form.append("title", p.title);
      if (p.content !== undefined) form.append("content", p.content);
      form.append("foreignId", p.handle);
      if (spaceId) form.append("spaceId", spaceId);
      form.append("images.files", new Blob([bytes], { type: contentType }), `${p.handle}.jpg`);
      created = await http("POST", api("/entities"), { token, form, label: ctx });
    } else {
      created = await http("POST", api("/entities"), {
        token,
        json: {
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.content !== undefined ? { content: p.content } : {}),
          foreignId: p.handle,
          ...(spaceId ? { spaceId } : {}),
        },
        label: ctx,
      });
    }
    p.id = created.id;
    console.log(`  ✓ ${p.handle.padEnd(10)} "${p.title ?? ""}"  by ${p.author}${p.space ? ` in ${p.space}` : ""}${p.image ? "  📷" : ""}`);
  }
}

// ── 6. comments ───────────────────────────────────────────────────────────────
async function seedComments() {
  const comments = realized.comments ?? [];
  phase("comments", comments.length);
  for (const cm of comments) {
    const ctx = `comment "${cm.handle}"`;
    const token = tokenFor(cm.author, ctx);
    const body = {
      entityId: refId("posts", cm.entity, ctx),
      ...(cm.parent !== undefined ? { parentId: refId("comments", cm.parent, ctx) } : {}),
      ...(cm.content !== undefined ? { content: cm.content } : {}),
      foreignId: cm.handle,
    };
    const created = await http("POST", api("/comments"), { token, json: body, label: ctx });
    cm.id = created.id;
    console.log(`  ✓ ${cm.handle.padEnd(4)} ${cm.author} on ${cm.entity}${cm.parent ? ` ↪ ${cm.parent}` : ""}`);
  }
}

// ── 7. connections ──────────────────────────────────────────────────────────
// Request as `from`; if accept:true, accept as `to`. (Root /v7 routes — project from the token.)
async function seedConnections() {
  const conns = realized.connections ?? [];
  phase("connections", conns.length);
  for (const cn of conns) {
    const ctx = `connection ${cn.from}↔${cn.to}`;
    const fromToken = tokenFor(cn.from, ctx);
    const toId = refId("users", cn.to, ctx);
    const requested = await http("POST", root(`/users/${toId}/connection`), {
      token: fromToken, json: cn.message ? { message: cn.message } : {}, label: `${ctx} (request)`,
    });
    let status = requested.status ?? "pending";
    if (cn.accept) {
      const toToken = tokenFor(cn.to, ctx);
      const accepted = await http("PATCH", root(`/connections/${requested.id}/accept`), {
        token: toToken, json: {}, label: `${ctx} (accept)`,
      });
      status = accepted.status ?? "connected";
    }
    console.log(`  ✓ ${cn.from} ↔ ${cn.to}  [${status}]`);
  }
}

// ── 8. reactions ──────────────────────────────────────────────────────────────
// Toggle a reaction once. Edge group — applied exactly once on a clean DB (re-running would TOGGLE OFF).
async function seedReactions() {
  const reactions = realized.reactions ?? [];
  phase("reactions", reactions.length);
  for (const r of reactions) {
    const ctx = `reaction by ${r.by}`;
    const token = tokenFor(r.by, ctx);
    let url;
    if (r.on?.post !== undefined) url = api(`/entities/${refId("posts", r.on.post, ctx)}/reactions`);
    else if (r.on?.comment !== undefined) url = api(`/comments/${refId("comments", r.on.comment, ctx)}/reactions`);
    else die(`${ctx}: reaction needs on:{post|comment}`);
    await http("POST", url, { token, json: { reactionType: r.type }, label: ctx });
    const target = r.on.post ? `post ${r.on.post}` : `comment ${r.on.comment}`;
    console.log(`  ✓ ${r.by.padEnd(6)} ${r.type} → ${target}`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🌱 Agora seed engine`);
  console.log(`   manifest : ${MANIFEST_PATH}`);
  console.log(`   target   : ${BASE}/v7/${PROJECT_ID}`);

  await seedUsers();
  await seedRoles();
  await seedSpaces();
  await seedMemberships();
  await seedFollows();
  await seedPosts();
  await seedComments();
  await seedConnections();
  await seedReactions();

  const counts = ["users", "spaces", "memberships", "follows", "posts", "comments", "connections", "reactions"]
    .map((g) => `${(realized[g] ?? []).length} ${g}`)
    .join(", ");
  // roles isn't a top-level group — it's a per-user field, so it's counted across users.
  const roles = (realized.users ?? []).reduce((n, u) => n + (u.roles?.length ?? 0), 0);
  console.log(`\n✅ seed complete — ${counts}, ${roles} role grant(s).`);
}

main().catch((e) => die(e.message));
