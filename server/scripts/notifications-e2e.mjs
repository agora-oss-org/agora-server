// E2E notification fan-out test. Bob acts on Alice's seeded content; we assert Alice's inbox
// gains the right notification types — and that self-actions never notify.
// Run from server/ with the server booted on :4000 and the seed applied. ACCESS_TOKEN_SECRET in env.
import { SignJWT } from "jose";

const P = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // owns entity e1111… "Hello Agora"
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ENTITY = "e1111111-1111-1111-1111-111111111111";
const secret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);
const mint = (sub) => new SignJWT({ role: "visitor" }).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setExpirationTime("1h").sign(secret);

const base = `http://localhost:4000/v7/${P}`;
const call = (method, path, tok, body) =>
  fetch(base + path, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const fail = (m) => { console.error("❌ FAIL:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const aT = await mint(ALICE);
const bT = await mint(BOB);

// Snapshot Alice's + Bob's inbox type-counts before we act.
const typeCounts = async (tok) => {
  const res = await call("GET", "/app-notifications?limit=100", tok);
  const counts = {};
  for (const n of res.data ?? []) counts[n.type] = (counts[n.type] ?? 0) + 1;
  return counts;
};
const aBefore = await typeCounts(aT);
const bBefore = await typeCounts(bT);

// ── act ──────────────────────────────────────────────────────────────────────
// 1. Bob comments top-level on Alice's entity → Alice gets entity-comment.
const c1 = await call("POST", "/comments", bT, { entityId: ENTITY, content: "Bob says hi" });
if (!c1.id) fail("bob comment failed: " + JSON.stringify(c1));
console.log("✓ bob commented:", c1.id);

// 2. Alice replies to Bob's comment → Bob gets comment-reply.
const c2 = await call("POST", "/comments", aT, { entityId: ENTITY, parentId: c1.id, content: "Alice replies" });
if (!c2.id) fail("alice reply failed: " + JSON.stringify(c2));
console.log("✓ alice replied:", c2.id);

// 3. Alice comments on her OWN entity → must NOT notify herself.
const c3 = await call("POST", "/comments", aT, { entityId: ENTITY, content: "Alice talking to herself" });
if (!c3.id) fail("alice self-comment failed: " + JSON.stringify(c3));
console.log("✓ alice self-commented (should NOT notify):", c3.id);

// 4. Bob upvotes Alice's entity → Alice gets entity-upvote. (clear first so it's a fresh add)
await call("DELETE", `/entities/${ENTITY}/reactions`, bT);
await call("POST", `/entities/${ENTITY}/reactions`, bT, { type: "upvote" });
console.log("✓ bob upvoted alice's entity");

// 5. Bob loves Alice's entity (switch) → Alice gets entity-reaction (reactionType=love).
await call("POST", `/entities/${ENTITY}/reactions`, bT, { type: "love" });
console.log("✓ bob switched to love");

// 6. Bob follows Alice → Alice gets new-follow. (unfollow first so it's a fresh follow)
await call("DELETE", `/users/${ALICE}/follow`, bT);
const f = await call("POST", `/users/${ALICE}/follow`, bT);
console.log("✓ bob followed alice:", JSON.stringify(f));

await sleep(400); // let the awaited inserts settle (they're awaited, but be generous)

// ── assert ─────────────────────────────────────────────────────────────────────
const aAfter = await typeCounts(aT);
const bAfter = await typeCounts(bT);
const delta = (after, before, type) => (after[type] ?? 0) - (before[type] ?? 0);

const checks = [
  ["alice", "entity-comment", delta(aAfter, aBefore, "entity-comment") >= 1],
  ["bob", "comment-reply", delta(bAfter, bBefore, "comment-reply") >= 1],
  ["alice", "entity-upvote", delta(aAfter, aBefore, "entity-upvote") >= 1],
  ["alice", "entity-reaction", delta(aAfter, aBefore, "entity-reaction") >= 1],
  ["alice", "new-follow", delta(aAfter, aBefore, "new-follow") >= 1],
];
for (const [who, type, ok] of checks) {
  if (!ok) fail(`${who} missing notification "${type}" (before=${JSON.stringify(who === "bob" ? bBefore : aBefore)} after=${JSON.stringify(who === "bob" ? bAfter : aAfter)})`);
  console.log(`✓ ${who} received "${type}"`);
}

// Self-notify guard: Alice's entity-comment delta should be exactly 1 (Bob's), NOT 2 (her self-comment must not count).
const ec = delta(aAfter, aBefore, "entity-comment");
if (ec !== 1) fail(`self-notify leak: alice entity-comment delta is ${ec}, expected exactly 1 (her self-comment must not notify)`);
console.log("✓ self-comment did NOT notify alice (delta exactly 1)");

// Spot-check metadata shape on the newest entity-comment for Alice.
const inbox = await call("GET", "/app-notifications?limit=20", aT);
const ecNote = (inbox.data ?? []).find((n) => n.type === "entity-comment");
const need = ["entityId", "entityShortId", "commentId", "commentContent", "initiatorId", "initiatorName", "initiatorUsername"];
const missing = need.filter((k) => !(k in (ecNote?.metadata ?? {})));
if (missing.length) fail(`entity-comment metadata missing keys: ${missing.join(", ")} — got ${JSON.stringify(ecNote?.metadata)}`);
console.log("✓ entity-comment metadata shape OK:", JSON.stringify(ecNote.metadata));

console.log("\n🎉 notification fan-out E2E passed");
process.exit(0);
