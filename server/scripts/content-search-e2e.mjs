// E2E for semantic search across source types. Creates an entity, a comment, and a chat message
// all about a distinctive topic, waits for async embedding, then /search/content and asserts each
// source type comes back + sourceTypes filtering works. Run from server/ with the server on :4000
// and VOYAGE_API_KEY set. ACCESS_TOKEN_SECRET in env.
import { SignJWT } from "jose";

const P = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const secret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);
const tok = await new SignJWT({ role: "visitor" }).setProtectedHeader({ alg: "HS256" }).setSubject(ALICE).setExpirationTime("1h").sign(secret);
const base = `http://localhost:4000/v7/${P}`;
const call = (method, path, body) =>
  fetch(base + path, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const fail = (m) => { console.error("❌ FAIL:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tag = "axolotl-" + Date.now(); // distinctive so it dominates similarity
const ent = await call("POST", "/entities", { title: `Axolotl care ${tag}`, content: "Keeping axolotls: cool water, no gravel, feed earthworms." });
if (!ent.id) fail("entity create: " + JSON.stringify(ent));
const cmt = await call("POST", "/comments", { entityId: ent.id, content: `My axolotl ${tag} loves a chilled tank around 16C.` });
if (!cmt.id) fail("comment create: " + JSON.stringify(cmt));
const convo = await call("POST", "/chat/conversations", { name: "tank talk", type: "group" });
const msg = await call("POST", `/chat/conversations/${convo.id}/messages`, { content: `Anyone else keep axolotls ${tag}? Mine refuses pellets.` });
if (!msg.id) fail("message create: " + JSON.stringify(msg));
console.log("✓ created entity/comment/message; waiting for embedding…");

await sleep(3000); // async Voyage indexing

const q = { query: "how do I care for an axolotl in its tank", limit: 20 };

// all source types
const all = await call("POST", "/search/content", { ...q, sourceTypes: ["entity", "comment", "message"] });
if (!Array.isArray(all)) fail("search/content did not return an array: " + JSON.stringify(all));
const got = new Set(all.map((r) => r.sourceType));
console.log("→ source types returned:", [...got].join(", "));
for (const t of ["entity", "comment", "message"]) if (!got.has(t)) fail(`expected a ${t} result among: ${JSON.stringify(all.map((r) => ({ t: r.sourceType, id: r.record?.id })))}`);
// our freshly-created ids should be present
const ids = new Set(all.map((r) => r.record?.id));
for (const [label, id] of [["entity", ent.id], ["comment", cmt.id], ["message", msg.id]]) if (!ids.has(id)) fail(`our ${label} ${id} not in results`);
console.log("✓ all three source types returned, including our new rows");

// sourceTypes filtering → comments only
const onlyComments = await call("POST", "/search/content", { ...q, sourceTypes: ["comment"] });
if (onlyComments.some((r) => r.sourceType !== "comment")) fail("comment-only filter leaked other types: " + JSON.stringify(onlyComments.map((r) => r.sourceType)));
console.log("✓ sourceTypes:['comment'] returns only comments");

console.log("\n🎉 semantic search across source types E2E passed");
process.exit(0);
