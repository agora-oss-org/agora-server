// E2E for the expanded webhook event coverage. Stands up a local receiver that verifies the
// X-Signature HMAC, vetoes a "DENYME" payload (validate stage), and records *.complete broadcasts.
// Exercises entity.updated (deny + allow), space.created, message.created, user.updated against a
// throwaway project. Run from server/ with the server on :4000. Needs DATABASE_URL + ACCESS_TOKEN_SECRET.
import http from "node:http";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { SignJWT } from "jose";

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("❌ DATABASE_URL required"); process.exit(1); }
const sql = postgres(DB, { prepare: false, onnotice() {} });
const SECRET = "whsec_" + randomUUID().replace(/-/g, "");
const PORT = 4137;
const fail = async (m) => { console.error("❌ FAIL:", m); await cleanup(); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (msg) => crypto.createHmac("sha256", SECRET).update(msg).digest("hex");

// ── local webhook receiver ──────────────────────────────────────────────────
const broadcasts = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const sig = req.headers["x-signature"];
    const ts = req.headers["x-timestamp"];
    const expected = hmac(`${ts}.${raw}`);
    if (sig !== expected) { res.writeHead(400).end("bad signature"); return; }
    const env = JSON.parse(raw);
    if (env.stage === "validate") {
      const deny = JSON.stringify(env.data).includes("DENYME");
      const bodyText = JSON.stringify(deny ? { valid: false, message: "vetoed by test" } : { valid: true });
      res.writeHead(200, { "content-type": "application/json", "x-response-signature": hmac(bodyText) }).end(bodyText);
    } else {
      broadcasts.push(env.type);
      res.writeHead(200).end("ok");
    }
  });
});
await new Promise((r) => server.listen(PORT, r));

// ── throwaway project + user ──────────────────────────────────────────────────
const [proj] = await sql`insert into projects (client_id, name) values (${"wh-" + Date.now()}, ${"wh-test"}) returning id`;
const P = proj.id;
const [prof] = await sql`insert into profiles (project_id, username) values (${P}, ${"wh_" + randomUUID().slice(0, 8)}) returning id`;
const U = prof.id;
const events = ["entity.updated", "entity.updated.complete", "space.created", "space.created.complete",
  "message.created", "message.created.complete", "user.updated", "user.updated.complete"];
await sql`update projects set webhook_url = ${`http://localhost:${PORT}/hook`}, webhook_secret = ${SECRET}, webhook_events = ${events} where id = ${P}`;

const token = await new SignJWT({ role: "visitor" }).setProtectedHeader({ alg: "HS256" }).setSubject(U).setExpirationTime("1h").sign(new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET));
const base = `http://localhost:4000/v7/${P}`;
const call = (method, path, body) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

async function cleanup() {
  try { await sql`delete from projects where id = ${P}`; } catch {}
  await sql.end().catch(() => {});
  server.close();
}

try {
  // entity to update
  const ent = await (await call("POST", "/entities", { title: "wh", content: "ok" })).json();

  // 1. entity.updated DENY (validate veto → 403)
  const denied = await call("PATCH", `/entities/${ent.id}`, { content: "DENYME please" });
  if (denied.status !== 403) await fail(`entity.updated deny expected 403, got ${denied.status}`);
  console.log("✓ entity.updated validation veto → 403");

  // 2. entity.updated ALLOW (→ 200 + broadcast)
  const ok = await call("PATCH", `/entities/${ent.id}`, { content: "all good" });
  if (ok.status !== 200) await fail(`entity.updated allow expected 200, got ${ok.status} ${await ok.text()}`);
  console.log("✓ entity.updated allowed → 200");

  // 3. space.created (→ 201 + broadcast)
  const space = await call("POST", "/spaces", { name: "WH Space" });
  if (space.status !== 201) await fail(`space.created expected 201, got ${space.status}`);

  // 4. message.created (→ 201 + broadcast)
  const convo = await (await call("POST", "/chat/conversations", { name: "wh", type: "group" })).json();
  const msg = await call("POST", `/chat/conversations/${convo.id}/messages`, { content: "hi" });
  if (msg.status !== 201) await fail(`message.created expected 201, got ${msg.status} ${await msg.text()}`);

  // 5. user.updated (→ 200 + broadcast)
  const upd = await call("PATCH", `/users/${U}`, { name: "Webhook Tester" });
  if (upd.status !== 200) await fail(`user.updated expected 200, got ${upd.status}`);
  console.log("✓ space.created / message.created / user.updated all accepted");

  // broadcasts are fire-and-forget — give them a moment to arrive + verify HMAC-delivered
  await sleep(800);
  for (const t of ["entity.updated.complete", "space.created.complete", "message.created.complete", "user.updated.complete"]) {
    if (!broadcasts.includes(t)) await fail(`missing HMAC-verified broadcast "${t}" — got [${broadcasts.join(", ")}]`);
  }
  console.log("✓ all *.complete broadcasts delivered + HMAC-verified:", [...new Set(broadcasts)].join(", "));

  console.log("\n🎉 webhook event-coverage E2E passed");
} catch (e) {
  await fail(e?.message ?? String(e));
}
await cleanup();
process.exit(0);
