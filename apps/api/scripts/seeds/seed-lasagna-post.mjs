// Seed a sample "lasagna" feed post owned by the demo user, with an image uploaded through the
// normal entity pipeline (multipart → sharp variants → Storage → files row). Complements the miso
// soup post (scripts/seeds/seed-miso-post.mjs). Idempotent: skips if the post already exists. Run from
// agora/server:  node scripts/seeds/seed-lasagna-post.mjs
// Requires the demo auth user (node scripts/seeds/00-seed-auth-admin.mjs) and a reachable Agora server.
// Env (all optional): API_BASE_URL (default http://localhost:4000), PROJECT_ID (default 11111111-…),
// DEMO_EMAIL / DEMO_PASSWORD, LASAGNA_IMAGE_URL.
import "dotenv/config";
import { fetchSeedImageBytes } from "./lib/seed-images.mjs";

const BASE = (process.env.API_BASE_URL || "http://localhost:4000").replace(/\/$/, "").replace(/\/v7$/, "");
const PROJECT_ID = process.env.PROJECT_ID || "11111111-1111-1111-1111-111111111111";
const EMAIL = process.env.DEMO_EMAIL || "agora-admin@gmail.com";
const PASSWORD = process.env.DEMO_PASSWORD || "DemoPass123!";

// Original copy (not reproduced from any source) — a friendly demo post that pairs with the miso soup.
const TITLE = "Sunday-best lasagna 🍝";
const CONTENT =
  "The ultimate comfort bake to set next to that miso soup: layers of tender pasta, a rich " +
  "slow-simmered meat-and-tomato sauce, and a creamy ricotta–mozzarella tangle, baked until the " +
  "edges go golden and bubbly. Make it the day before — it only gets better overnight. Leftovers " +
  "not guaranteed. 🧀🍅";

const api = (path) => `${BASE}/v7/${PROJECT_ID}${path}`;

// 1. Sign in as the demo user → access token.
const signIn = await fetch(api("/auth/sign-in"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!signIn.ok) {
  const msg = await signIn.text().catch(() => "");
  die(`sign-in failed (${signIn.status}). Does the demo user exist? Run: node scripts/seeds/00-seed-auth-admin.mjs\n${msg}`);
}
const { accessToken } = await signIn.json();
if (!accessToken) die("sign-in returned no accessToken");

// 2. Skip if this post already exists in the feed (avoid duplicates on re-run).
const feed = await fetch(api(`/entities?limit=100`), {
  headers: { Authorization: `Bearer ${accessToken}` },
}).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const existing = feed?.data?.find?.((e) => e.title === TITLE);
if (existing) {
  console.log(`✓ post already exists (id ${existing.id}) — nothing to do.`);
  process.exit(0);
}

// 3. Download the image bytes.
console.log(`Downloading image: lasagna`);
const { bytes, contentType } = await fetchSeedImageBytes("lasagna");
const filename = "lasagna.jpg";

// 4. Create the entity as multipart (title + content + images.files) — the server runs the image
//    through sharp → Storage → a files row linked to the new entity (same path the SDK uses).
const form = new FormData();
form.append("title", TITLE);
form.append("content", CONTENT);
form.append("images.files", new Blob([bytes], { type: contentType }), filename);

const create = await fetch(api("/entities"), {
  method: "POST",
  headers: { Authorization: `Bearer ${accessToken}` }, // do NOT set Content-Type; fetch sets the multipart boundary
  body: form,
});
if (!create.ok) {
  const msg = await create.text().catch(() => "");
  die(`create entity failed (${create.status})\n${msg}`);
}
const entity = await create.json();
console.log(`✅ created post "${TITLE}"`);
console.log(`   id     : ${entity.id}`);
console.log(`   images : ${entity.files?.length ?? 0}`);
process.exit(0);

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
