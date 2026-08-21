// 📝 NEW BLOG — create a blog-post entity owned by the admin, through the RUNNING API (so the
//   profile auto-creates on sign-in and the normal pipeline runs: posting gates, validation webhook,
//   embeddings, triggers). The slug lands on the entity's `foreignId` — unique per project and
//   queryable via GET /entities/by-foreign-id?foreignId=<slug> — which is also this script's
//   idempotency key: an existing slug is reported and left untouched.
//
//   node scripts/new-blog.mjs --slug my-first-post
//   node scripts/new-blog.mjs --slug hello --title "Hello, world" --content "…"
//   node scripts/new-blog.mjs --slug hello --file ./posts/hello.md        # content from a file
//   node scripts/new-blog.mjs --slug hello --space <uuid>                 # post into an existing space
//   node scripts/new-blog.mjs --slug hello --public                       # + internet-public
//                                                                         # (PATCH /:id/visibility —
//                                                                         # space-less or public-space
//                                                                         # content only, per the server)
//   node scripts/new-blog.mjs --slug hello --un me@x.org --pw 's3cret'    # sign in as this account
//                                                                         # (⚠ argv is visible in `ps` +
//                                                                         # shell history — prefer the
//                                                                         # env vars for real secrets)
//
// Env: API_BASE_URL (default http://localhost:4000), PROJECT_ID (default the seed project; --project
// wins), ADMIN_EMAIL/ADMIN_PASSWORD (falls back to DEMO_EMAIL/DEMO_PASSWORD, then the demo default;
// --un/--pw win over all of them) — the entity is owned by whoever these credentials sign in as.
import "dotenv/config";
import { readFileSync } from "node:fs";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const slug = readArg("--slug");
if (!slug) {
  console.error("✗ --slug is required (e.g. --slug my-first-post)");
  process.exit(1);
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  console.error(`✗ --slug must be lowercase kebab-case (a-z, 0-9, hyphen-separated), got: ${slug}`);
  process.exit(1);
}

const projectId = (readArg("--project") ?? process.env.PROJECT_ID ?? "11111111-1111-1111-1111-111111111111").toLowerCase();
if (!UUID_RE.test(projectId)) {
  console.error(`✗ --project must be a UUID, got: ${projectId}`);
  process.exit(1);
}

const spaceId = readArg("--space")?.toLowerCase() ?? null; // optional — omit to post space-less
if (spaceId && !UUID_RE.test(spaceId)) {
  console.error(`✗ --space must be a UUID (an existing space's id), got: ${spaceId}`);
  process.exit(1);
}

// Title defaults to the slug, humanized ("my-first-post" → "My First Post").
const title =
  readArg("--title") ?? slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// Content: --file (read from disk) beats --content beats a placeholder draft body.
const filePath = readArg("--file");
const contentArg = readArg("--content");
if (filePath && contentArg) {
  console.error("✗ pass --file OR --content, not both");
  process.exit(1);
}
const content = filePath ? readFileSync(filePath, "utf8") : contentArg ?? `Draft: ${title}`;

const makePublic = argv.includes("--public");

const BASE = (process.env.API_BASE_URL || "http://localhost:4000").replace(/\/$/, "").replace(/\/v7$/, "");
const EMAIL =
  readArg("--un") || process.env.ADMIN_EMAIL || process.env.DEMO_EMAIL || "agora-admin@agora-oss.org";
const PASSWORD =
  readArg("--pw") || process.env.ADMIN_PASSWORD || process.env.DEMO_PASSWORD || "DemoPass123!";
const api = (path) => `${BASE}/v7/${projectId}${path}`;

console.log(`📝 new-blog → ${BASE}  project ${projectId}`);
console.log(`   slug  : ${slug}`);
console.log(`   title : ${title}${spaceId ? `\n   space : ${spaceId}` : ""}${makePublic ? "\n   visibility: internet-public" : ""}\n`);

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// 1. Sign in as the admin → the entity's owner (profile auto-creates on first sign-in).
const signIn = await fetch(api("/auth/sign-in"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).catch((e) => die(`cannot reach the API at ${BASE} — is it running? (${e.message})`));
if (!signIn.ok) {
  die(`sign-in failed (${signIn.status}) for ${EMAIL} on project ${projectId}. Does the admin exist there? Seed with scripts/seeds/00-seed-auth-admin.mjs\n${await signIn.text().catch(() => "")}`);
}
const { accessToken } = await signIn.json();
if (!accessToken) die("sign-in returned no accessToken");
const authed = { Authorization: `Bearer ${accessToken}` };

// 2. Idempotency: an entity already holding this slug (foreignId) is reported, never touched.
//    NOTE: no createIfNotFound — that mode upserts an AUTHORLESS anchor, which is not a blog post.
const existing = await fetch(api(`/entities/by-foreign-id?foreignId=${encodeURIComponent(slug)}`), { headers: authed });
if (existing.ok) {
  const e = await existing.json();
  console.log(`○ slug "${slug}" already exists — entity ${e.id} ("${e.title ?? "untitled"}") left untouched.`);
  process.exit(0);
}

// 3. Create the entity (normal pipeline: posting gate, validation webhook, embedding, mentions).
const created = await fetch(api("/entities"), {
  method: "POST",
  headers: { ...authed, "Content-Type": "application/json" },
  body: JSON.stringify({ title, content, foreignId: slug, ...(spaceId ? { spaceId } : {}) }),
});
if (!created.ok) die(`entity create failed (${created.status}):\n${await created.text().catch(() => "")}`);
const entity = await created.json();
console.log(`✅ blog entity created — id ${entity.id}  shortId ${entity.shortId}`);

// 4. Optionally lift it onto the anonymous internet-public surface (server enforces the ladder:
//    only space-less or public-space content may go internet-public).
if (makePublic) {
  const vis = await fetch(api(`/entities/${entity.id}/visibility`), {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ public: true }),
  });
  if (!vis.ok) {
    console.error(`✗ created, but making it internet-public failed (${vis.status}):\n${await vis.text().catch(() => "")}`);
    process.exitCode = 1;
  } else {
    console.log(`🌐 internet-public → ${BASE}/v7/${projectId}/public/entities/${entity.id}`);
  }
}
