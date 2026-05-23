// E2E realtime test: alice creates a direct convo with bob; bob connects via socket.io and
// joins; alice POSTs a message; assert bob receives message:created. Then test a reaction.
// Run from server/ with the server already booted on :4000. ACCESS_TOKEN_SECRET in env.
import { io } from "socket.io-client";
import { SignJWT } from "jose";

const P = "11111111-1111-1111-1111-111111111111";
const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const secret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);
const mint = (sub) => new SignJWT({ role: "visitor" }).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setExpirationTime("1h").sign(secret);

const base = `http://localhost:4000/v7/${P}`;
const call = (method, path, tok, body) =>
  fetch(base + path, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

const aT = await mint(ALICE);
const bT = await mint(BOB);

const convo = await call("POST", "/chat/conversations/direct", aT, { userId: BOB });
if (!convo.id) fail("no conversation created: " + JSON.stringify(convo));
console.log("✓ direct conversation:", convo.id, "type:", convo.type);

const sock = io("http://localhost:4000", { auth: { token: bT }, query: { projectId: P }, transports: ["websocket"] });
await new Promise((res, rej) => { sock.on("connect", res); sock.on("connect_error", (e) => rej(e.message)); setTimeout(() => rej("connect timeout"), 5000); }).catch(fail);
console.log("✓ bob socket connected:", sock.id);

const gotCreated = new Promise((res) => sock.on("message:created", res));
const gotReaction = new Promise((res) => sock.on("message:reaction", res));
sock.emit("join:conversation", { conversationId: convo.id });
await new Promise((r) => setTimeout(r, 600)); // allow join + membership check

const msg = await call("POST", `/chat/conversations/${convo.id}/messages`, aT, { content: "hello realtime" });
if (!msg.id) fail("message not sent: " + JSON.stringify(msg));
console.log("✓ alice sent message:", msg.id);

const received = await Promise.race([gotCreated, new Promise((_, rej) => setTimeout(() => rej("timeout: no message:created"), 5000))]).catch(fail);
console.log("✓ BOB RECEIVED message:created →", JSON.stringify({ id: received.id, content: received.content }));
if (received.id !== msg.id) fail("received id mismatch");

// bob reacts; alice would receive — we just assert the event fans out to the room (bob also gets it)
await call("POST", `/chat/conversations/${convo.id}/messages/${msg.id}/reactions`, bT, { emoji: "🔥" });
const reaction = await Promise.race([gotReaction, new Promise((_, rej) => setTimeout(() => rej("timeout: no message:reaction"), 5000))]).catch(fail);
console.log("✓ message:reaction fanned out →", JSON.stringify({ emoji: reaction.emoji, delta: reaction.delta, counts: reaction.reactionCounts }));

console.log("\n🎉 chat realtime E2E passed");
sock.close();
process.exit(0);
