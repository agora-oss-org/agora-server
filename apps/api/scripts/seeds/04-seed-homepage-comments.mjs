// Seed the "homepage-comments" entity — an addressable comment anchor (Replyke/Agora `foreignId`) that
// a website homepage embeds to show Agora's commenting in action. Owned by the seed admin, its content
// a warm welcome inviting visitors to join the conversation.
//
// The anchor is also published INTERNET-PUBLIC, so the homepage can render it with **no visitor
// account** via the anonymous surface (`GET /v7/:projectId/public/entities/:id` + `/comments`) —
// which is the whole point of a homepage embed. Publishing goes through the real privileged action
// (PATCH /entities/:id/visibility); the entity is spaceless, so it satisfies the visibility ladder
// (internet ⊇ community ⊇ private) and only operator / project-admin may flip it. See
// docs/PUBLIC-API.md.
//
// Idempotent: re-running skips creation if the entity exists, and publishes it only if it isn't
// already public — so a run against an existing-but-unpublished anchor converges. Run from agora/server:
//   node scripts/seeds/seed-homepage-comments.mjs
// Requires the seed auth user (node scripts/seeds/00-seed-auth-admin.mjs) and a reachable Agora server. Env
// (all optional): API_BASE_URL (default http://localhost:4000), PROJECT_ID (default 11111111-…),
// DEMO_EMAIL / DEMO_PASSWORD.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.API_BASE_URL || "http://localhost:4000").replace(/\/$/, "").replace(/\/v7$/, "");
const PROJECT_ID = process.env.PROJECT_ID || "11111111-1111-1111-1111-111111111111";
const EMAIL = process.env.DEMO_EMAIL || "agora-admin@agora-oss.org";
const PASSWORD = process.env.DEMO_PASSWORD || "DemoPass123!";

// The addressable id the homepage embeds: useEntity({ foreignId: "homepage-comments" }).
const FOREIGN_ID = "homepage-comments";

// Original copy (not reproduced from any source) — the anchor "post" the homepage comments hang off,
// a warm welcome inviting visitors to join the conversation.
const TITLE = "Welcome to the conversation 👋";
const CONTENT =
  "Hi, and welcome! 🌸 Thanks for stopping by — I'm so glad you're here. This is a real, working example of Agora's commenting: leave a thought about Agora, reply to someone else, or just drop a 👋. Every voice is welcome, so don't be shy — We'd love to hear from you. 💛";

const api = (path) => `${BASE}/v7/${PROJECT_ID}${path}`;

// 1. Sign in as the seed user → access token.
const signIn = await fetch(api("/auth/sign-in"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!signIn.ok) {
  const msg = await signIn.text().catch(() => "");
  die(`sign-in failed (${signIn.status}). Does the seed user exist? Run: node scripts/seeds/00-seed-auth-admin.mjs\n${msg}`);
}
const { accessToken } = await signIn.json();
if (!accessToken) die("sign-in returned no accessToken");
const auth = { Authorization: `Bearer ${accessToken}` };

// 2. Find-or-create the anchor entity (addressed by foreignId). The by-foreign-id lookup 404s when
//    missing; we create an AUTHORED entity (owned by the admin) rather than the SDK's authorless
//    createIfNotFound anchor, so the example shows a real poster.
let entity = await fetch(api(`/entities/by-foreign-id?foreignId=${encodeURIComponent(FOREIGN_ID)}`), {
  headers: auth,
}).then((r) => (r.ok ? r.json() : null)).catch(() => null);

if (entity) {
  console.log(`✓ entity "${FOREIGN_ID}" already exists (id ${entity.id}).`);
} else {
  const create = await fetch(api("/entities"), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ title: TITLE, content: CONTENT, foreignId: FOREIGN_ID }),
  });
  if (!create.ok) {
    const msg = await create.text().catch(() => "");
    die(`create entity failed (${create.status})\n${msg}`);
  }
  entity = await create.json();
  console.log(`✅ created entity "${FOREIGN_ID}" (id ${entity.id})`);
}

// 3. Publish it to the anonymous /public/* surface (idempotent — skip if already there).
//    Authority is operator / project-admin: the seed admin qualifies via OPERATOR_EMAILS, which the
//    dev + selfhost .env templates ship containing this address. A deployment that changed it (the
//    prod template ships a placeholder) gets a loud warning rather than a failed seed — the anchor
//    itself is still created and usable behind the auth wall.
if (entity.public) {
  console.log(`✓ entity "${FOREIGN_ID}" is already internet-public.`);
} else {
  const publish = await fetch(api(`/entities/${entity.id}/visibility`), {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ public: true }),
  });
  if (publish.ok) {
    entity = await publish.json();
    console.log(`✅ published "${FOREIGN_ID}" internet-public`);
  } else if (publish.status === 403) {
    console.warn(
      `⚠ could not publish "${FOREIGN_ID}" internet-public (403): ${EMAIL} is not an operator or\n` +
      `  project admin on this deployment. The anchor exists and works behind the auth wall; to serve\n` +
      `  it to signed-out visitors, add the address to OPERATOR_EMAILS (or grant it a project owner/\n` +
      `  admin role) and re-run this script.`
    );
  } else {
    const msg = await publish.text().catch(() => "");
    die(`publish entity failed (${publish.status})\n${msg}`);
  }
}

// 4. Seed the thread. A published anchor with an empty thread is a poor demo of *commenting*, so
//    hang a short conversation off it, authored by manifest users from seed.json (03-seed-engine
//    runs before this script and creates them — files are ordered alphabetically). Idempotent: skip
//    entirely if the anchor already has any comment, so a re-run never duplicates the thread.
//    Non-fatal throughout — running 04 standalone without 03 means these users don't exist, and an
//    anchor with no thread still beats a failed seed.
const THREAD = [
  { by: "alice", content: "Been looking for something like this for ages — self-hosted, and the comments actually feel like a conversation instead of a form." },
  { by: "bob",   content: "Same. The fact that I can read this without making an account is the part I keep pointing people at." },
  { by: "hana",  reply: 1, content: "That's the bit that sold me too. Public by choice, private by default — the right way round." },
  { by: "cara",  content: "👋 from the other side of the world. Lovely to see a project that treats its community as the feature." },
];

const existing = await fetch(api(`/comments?entityId=${entity.id}&limit=1`), { headers: auth })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);

if (existing?.pagination?.totalItems > 0) {
  console.log(`✓ thread already seeded (${existing.pagination.totalItems} comment(s)).`);
} else {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(here, "seed.json"), "utf8"));
  } catch {
    console.warn(`⚠ could not read seed.json — skipping the demo thread.`);
  }
  if (manifest) {
    const password = manifest.meta?.defaultPassword || "SeedPass123!";
    const byHandle = new Map((manifest.users ?? []).map((u) => [u.handle, u]));
    const posted = []; // index-aligned with THREAD so `reply` can address an earlier comment
    for (const [i, item] of THREAD.entries()) {
      const user = byHandle.get(item.by);
      if (!user) { console.warn(`⚠ seed.json has no user "${item.by}" — skipping that comment.`); posted[i] = null; continue; }
      const session = await fetch(api("/auth/sign-in"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email.trim().toLowerCase(), password: user.password || password }),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!session?.accessToken) {
        console.warn(`⚠ could not sign in "${item.by}" — has 03-seed-engine.mjs run? Skipping the rest of the thread.`);
        break;
      }
      const parentId = item.reply !== undefined ? posted[item.reply]?.id : undefined;
      const created = await fetch(api("/comments"), {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ entityId: entity.id, content: item.content, ...(parentId ? { parentId } : {}) }),
      });
      if (!created.ok) {
        const msg = await created.text().catch(() => "");
        console.warn(`⚠ comment by "${item.by}" failed (${created.status}) — skipping. ${msg}`);
        posted[i] = null;
        continue;
      }
      posted[i] = await created.json();
      console.log(`  ✓ comment by ${item.by}${parentId ? " (reply)" : ""}`);
    }
  }
}

console.log(`   embed with: useEntity({ foreignId: "${FOREIGN_ID}" })`);
if (entity.public) {
  // Prefer the foreignId form in copy-paste: it's stable across installs, where the uuid is
  // generated per seed run. Both resolve to the same entity through the same gate.
  console.log(`   anonymous:  GET ${api(`/public/entities/by-foreign-id?foreignId=${FOREIGN_ID}`)}`);
  console.log(`               GET ${api(`/public/entities/${entity.id}/comments`)}`);
}
process.exit(0);

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
