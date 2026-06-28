// Seed the "homepage-comments" entity — an addressable comment anchor (Replyke/Agora `foreignId`) that
// a website homepage embeds to show Agora's commenting in action. Owned by the seed admin, its content
// a warm welcome inviting visitors to join the conversation. Idempotent: re-running skips it if the
// entity already exists. Run from agora/server:
//   node scripts/seeds/seed-homepage-comments.mjs
// Requires the seed auth user (node scripts/seeds/seed-demo-user.mjs) and a reachable Agora server. Env
// (all optional): API_BASE_URL (default http://localhost:4000), PROJECT_ID (default 11111111-…),
// DEMO_EMAIL / DEMO_PASSWORD.
import "dotenv/config";

const BASE = (process.env.API_BASE_URL || "http://localhost:4000").replace(/\/$/, "").replace(/\/v7$/, "");
const PROJECT_ID = process.env.PROJECT_ID || "11111111-1111-1111-1111-111111111111";
const EMAIL = process.env.DEMO_EMAIL || "agora-admin@gmail.com";
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
  die(`sign-in failed (${signIn.status}). Does the seed user exist? Run: node scripts/seeds/seed-demo-user.mjs\n${msg}`);
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

console.log(`   embed with: useEntity({ foreignId: "${FOREIGN_ID}" })`);
process.exit(0);

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
