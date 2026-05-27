// Seed a sample "miso soup" feed post owned by the demo user, with an image uploaded through the
// normal entity pipeline (multipart → sharp variants → Storage → files row). Idempotent-ish: it
// skips creation if the demo user already has a post with the same title. Run from agora/server:
//   node scripts/seed-miso-post.mjs
// Requires the demo auth user to exist first (node scripts/seed-demo-user.mjs) and a reachable
// Agora server. Env (all optional): API_BASE_URL (default http://localhost:4000/v7),
// PROJECT_ID (default 11111111-…), DEMO_EMAIL / DEMO_PASSWORD, MISO_IMAGE_URL.
import "dotenv/config";

const BASE = (process.env.API_BASE_URL || "http://localhost:4000/v7").replace(/\/$/, "");
const PROJECT_ID = process.env.PROJECT_ID || "11111111-1111-1111-1111-111111111111";
const EMAIL = process.env.DEMO_EMAIL || "agora-demo@gmail.com";
const PASSWORD = process.env.DEMO_PASSWORD || "DemoPass123!";
const IMAGE_URL = process.env.MISO_IMAGE_URL || "https://www.yummytummyaarthi.com/wp-content/uploads/2021/03/miso-soup-1.jpg";

// Original copy (not reproduced from any source) — a friendly demo post.
const TITLE = "Weeknight miso soup 🍲";
const CONTENT =
  "My favorite 15-minute comfort bowl: warm dashi, a few cubes of silken tofu, and white miso " +
  "whisked in off the heat so it stays silky — never let it boil. Finished with a big handful of " +
  "green onions. Savory, cozy, and done before the rice cooker even beeps. 🥢";

const api = (path) => `${BASE}/${PROJECT_ID}${path}`;

// 1. Sign in as the demo user → access token.
const signIn = await fetch(api("/auth/sign-in"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!signIn.ok) {
  const msg = await signIn.text().catch(() => "");
  die(`sign-in failed (${signIn.status}). Does the demo user exist? Run: node scripts/seed-demo-user.mjs\n${msg}`);
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

// 3. Fetch the image bytes.
console.log(`Fetching image: ${IMAGE_URL}`);
const imgRes = await fetch(IMAGE_URL, { headers: { "User-Agent": "AgoraSeed/1.0" } });
if (!imgRes.ok) die(`image fetch failed (${imgRes.status})`);
const contentType = imgRes.headers.get("content-type") || "image/jpeg";
const bytes = new Uint8Array(await imgRes.arrayBuffer());
const filename = (IMAGE_URL.split("/").pop() || "miso-soup.jpg").split("?")[0];

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
