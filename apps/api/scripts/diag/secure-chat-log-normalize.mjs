#!/usr/bin/env node
// secure-chat-log-normalize.mjs — tier-1 secure-chat log correlator.
//
// Lifts two DIFFERENT secure-chat log streams into ONE common event schema so they can be
// merge-sorted into a single timeline and correlated:
//   • client SDK console logs   ([secure-chat:LAYER] LEVEL → /…)  — from @agora-sdk/secure-chat-* debug.ts
//   • API server logs           ([ISO] LEVEL : request {json})    — from wonder-logger (Pino)
//
// Format is auto-detected PER LINE, so arg order doesn't matter and a single interleaved file works.
//
//   node scripts/diag/secure-chat-log-normalize.mjs <log…>        # human report (default)
//   node scripts/diag/secure-chat-log-normalize.mjs --ndjson <log…>  # emit the normalized events only
//   cat client.log server.log | node scripts/diag/secure-chat-log-normalize.mjs --ndjson -
//
// The common event (one per normalized log line):
//   { ord, ts, source, layer, op, dir, method, path, pathTemplate, status,
//     deviceRowId, clientDeviceId, conversationId, epoch, seq, fields, msg, raw }
//
// WHY this exists: the client and server name the same operation with DIFFERENT identifiers
// (device-row churn) and the client emits no timestamps — so the two streams "look alike" but
// can't be eyeballed into alignment. Normalizing + correlating makes the divergence explicit.

import { readFileSync } from "node:fs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const reUuidG = new RegExp(UUID, "gi");

// ── path helpers ────────────────────────────────────────────────────────────
// Canonical secure-chat suffix: drop the `/v7/<project>/secure-chat` (server) prefix; the client
// already logs paths relative to the secure-chat base. Non-secure server paths keep their suffix.
function canonPath(p) {
  if (!p) return p;
  let s = p.replace(new RegExp(`^/v7/${UUID}/secure-chat`, "i"), "");
  if (s === p) s = p.replace(new RegExp(`^/v7/${UUID}`, "i"), ""); // non-secure: strip just /v7/<project>
  return s === "" ? "/" : s;
}
const templatePath = (p) => (p ? p.replace(reUuidG, ":id") : p);
// The device ROW id is the first uuid inside a /devices/<uuid>/… segment.
function deviceRowFromPath(p) {
  const m = p && p.match(new RegExp(`/devices/(${UUID})`, "i"));
  return m ? m[1] : undefined;
}

// ── op classifier (shared by both parsers) ──────────────────────────────────
function classify({ method, cpath, msg }) {
  const m = (msg || "").toLowerCase();
  if (m.includes("device registered") || m.includes("registered device")) return "device.register";
  if (m.includes("key packages published") || m.includes("replenished key-packages")) return "keypackages.publish";
  if (m.includes("handshakes delivered") || m.includes("handshakes polled")) return "handshakes.poll";
  if (m.startsWith("catch-up") || m.includes("re-joined socket") || m === "ready") return "handshakes.catchup";
  if (m.includes("connecting") && m.includes("namespace")) return "socket.connect";
  if (m.includes("connect_error")) return "socket.error";
  if (m.includes("conversation created")) return "conversation.create";
  if (m.includes("member added") || m.includes("member removed")) return "membership";
  if (m.includes("message sent")) return "message.send";
  if (m.includes("epoch conflict")) return "epoch.conflict";
  if (m.includes("refresh rotated")) return "auth.refresh";
  if (cpath) {
    if (/^\/devices\/[^/]+\/key-packages\/count/.test(cpath)) return "keypackages.count";
    if (/^\/devices\/[^/]+\/key-packages\/claim/.test(cpath)) return "keypackages.claim";
    if (/^\/devices\/[^/]+\/key-packages/.test(cpath)) return "keypackages.publish";
    if (/^\/devices\/[^/]+\/handshakes/.test(cpath)) return "handshakes.poll";
    if (/^\/devices(\/|$)/.test(cpath)) return "device.register";
    if (/^\/conversations\/[^/]+\/messages/.test(cpath)) return "message";
    if (/^\/conversations\/[^/]+\/members/.test(cpath)) return "membership";
    if (/^\/conversations/.test(cpath)) return "conversation";
    if (/^\/key-backup/.test(cpath)) return "keybackup";
  }
  return "other";
}

// ── client field extraction (the trailing braces are JS-object text, NOT JSON) ──
const fStr = (data, k) => {
  if (!data) return undefined;
  const m = data.match(new RegExp(`${k}:\\s*'([^']*)'`)) || data.match(new RegExp(`${k}:\\s*([^,}\\s]+)`));
  return m ? m[1] : undefined;
};

// ── client parser ───────────────────────────────────────────────────────────
function parseClient(line, ord) {
  let s = line.replace(/^\s*debug\.ts:\d+\s+/, "").trim(); // strip console source prefix
  const head = s.match(/^\[secure-chat:([^\]]+)\]\s+(\w+)\s+(.*)$/);
  if (!head) return null;
  const [, layer, level, body] = head;
  const ev = { ord, ts: null, source: "client", layer, level, op: "other", dir: "event",
    method: undefined, path: undefined, pathTemplate: undefined, status: undefined,
    deviceRowId: undefined, clientDeviceId: undefined, fields: {}, msg: undefined, raw: line };

  // REST request/response:  (→|←) [status] METHOD path [body] [{data}]
  const rest = body.match(/^(→|←)\s+(?:(\d{3})\s+)?([A-Z]+)\s+(\S+)(?:\s+body)?(?:\s+(\{.*\}|\[.*\]|.*))?$/);
  if (rest && (rest[1] === "→" || rest[1] === "←")) {
    const [, arrow, status, method, path, dataRaw] = rest;
    const cpath = canonPath(path);
    ev.dir = arrow === "→" ? "req" : "res";
    ev.method = method;
    ev.path = cpath;
    ev.pathTemplate = templatePath(cpath);
    ev.status = status ? Number(status) : undefined;
    ev.deviceRowId = deviceRowFromPath(cpath);
    ev.msg = `${arrow} ${method} ${ev.pathTemplate}`;
    const data = dataRaw && /[:{]/.test(dataRaw) ? dataRaw : undefined;
    // POST /devices response carries the new row id + the client device id.
    if (cpath === "/devices") {
      ev.deviceRowId = ev.deviceRowId || fStr(data, "id");
      ev.clientDeviceId = fStr(data, "deviceId");
    }
    for (const k of ["since", "limit", "available", "published", "hasMore", "count"]) {
      const v = fStr(data, k);
      if (v !== undefined) ev.fields[k] = v;
    }
    ev.op = classify({ method, cpath, msg: null });
    return ev;
  }

  // Non-REST events (device / handshakes / socket).
  ev.msg = body;
  const data = body.includes("{") ? body.slice(body.indexOf("{")) : undefined;
  ev.op = classify({ method: null, cpath: null, msg: body });
  // In handshake-layer events the logged `deviceId` IS the server row id (it keys the poll path).
  if (layer === "handshakes") ev.deviceRowId = fStr(data, "deviceId");
  if (layer === "device") ev.clientDeviceId = fStr(data, "deviceId");
  for (const k of ["fromCursor", "toCursor", "cursor", "available", "published", "deficit", "count", "message"]) {
    const v = fStr(data, k);
    if (v !== undefined) ev.fields[k] = v;
  }
  return ev;
}

// ── server parser (Pino aligned: `[ts] LEVEL : message {json}`) ─────────────
function parseServer(line, ord) {
  const head = line.match(/^\[([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+)\]\s+(\w+)\s*:\s+(.*)$/);
  if (!head) return null;
  const [, tsRaw, level, rest] = head;
  const ts = Date.parse(tsRaw.replace(" ", "T")); // local clock; fine for ordering
  const brace = rest.indexOf("{");
  const message = (brace >= 0 ? rest.slice(0, brace) : rest).trim();
  let data = null;
  if (brace >= 0) { try { data = JSON.parse(rest.slice(brace)); } catch { data = null; } }
  const ev = { ord, ts, source: "server", layer: "server", level, op: "other", dir: "event",
    method: undefined, path: undefined, pathTemplate: undefined, status: undefined,
    deviceRowId: undefined, clientDeviceId: undefined, fields: {}, msg: message, raw: line };

  if (message === "request" && data) {
    const cpath = canonPath(data.path);
    ev.dir = "res"; // the server "request" line is logged after handling — authoritative server view
    ev.method = data.method;
    ev.path = cpath;
    ev.pathTemplate = templatePath(cpath);
    ev.status = data.status;
    ev.deviceRowId = deviceRowFromPath(cpath);
    ev.layer = "rest";
    ev.msg = `← ${data.status} ${data.method} ${ev.pathTemplate}`;
    if (data.durationMs !== undefined) ev.fields.durationMs = data.durationMs;
    ev.op = classify({ method: data.method, cpath, msg: null });
    return ev;
  }
  // Domain debug lines (secure-chat: …, auth: …).
  ev.layer = message.startsWith("secure-chat:") ? "server-domain" : message.startsWith("auth:") ? "auth" : "server";
  if (data) {
    ev.deviceRowId = data.deviceRowId || deviceRowFromPath(data.path || "");
    ev.clientDeviceId = data.deviceId; // server logs the CLIENT text id as `deviceId`
    for (const k of ["submitted", "published", "members", "initialEpoch", "epoch", "returned", "since"]) {
      if (data[k] !== undefined) ev.fields[k] = data[k];
    }
  }
  ev.op = classify({ method: null, cpath: null, msg: message });
  return ev;
}

// ── line dispatcher ─────────────────────────────────────────────────────────
function parseLine(line, ord) {
  if (!line.trim()) return null;
  if (/^\[[0-9]{4}-[0-9]{2}-[0-9]{2} /.test(line)) return parseServer(line, ord);
  if (/\[secure-chat:/.test(line)) return parseClient(line, ord);
  return null; // banners / unrelated lines
}

// ── correlation report ──────────────────────────────────────────────────────
function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }

function report(events) {
  const client = events.filter((e) => e.source === "client");
  const server = events.filter((e) => e.source === "server");
  const out = [];
  out.push("═".repeat(78));
  out.push("  SECURE-CHAT LOG CORRELATION  ·  tier-1 normalizer");
  out.push("═".repeat(78));
  out.push(`  events: ${events.length}  (client ${client.length}, server ${server.length})`);

  // 1) Device-row id overlap — THE headline (are these even the same run?).
  const cRows = new Set(client.map((e) => e.deviceRowId).filter(Boolean));
  const sRows = new Set(server.map((e) => e.deviceRowId).filter(Boolean));
  const inter = [...cRows].filter((r) => sRows.has(r));
  out.push("");
  out.push("─ device-row ids ─────────────────────────────────────────────────────────");
  out.push(`  client saw : ${[...cRows].map((r) => r.slice(0, 8)).join(", ") || "(none)"}`);
  out.push(`  server saw : ${[...sRows].map((r) => r.slice(0, 8)).join(", ") || "(none)"}`);
  out.push(`  shared     : ${inter.map((r) => r.slice(0, 8)).join(", ") || "∅  ← NO OVERLAP"}`);
  if (inter.length === 0 && cRows.size && sRows.size) {
    out.push("  ⚠ client & server reference DISJOINT device rows → captures are different");
    out.push("    registrations (device churn), not two views of one operation.");
  }

  // 2) Op-level reachability (id-agnostic): did each client request reach the server?
  out.push("");
  out.push("─ op reachability (client request → server handled) ───────────────────────");
  out.push(`  ${pad("op", 22)}${pad("c.req", 7)}${pad("c.res", 7)}${pad("srv", 6)}gap?`);
  const ops = [...new Set(events.filter((e) => e.dir !== "event").map((e) => e.op))].sort();
  for (const op of ops) {
    const creq = client.filter((e) => e.op === op && e.dir === "req").length;
    const cres = client.filter((e) => e.op === op && e.dir === "res").length;
    const srv = server.filter((e) => e.op === op && e.dir === "res").length;
    const gap = creq > 0 && srv === 0 ? "⚠ never reached server" : creq > srv ? `⚠ ${creq - srv} unmatched` : "ok";
    out.push(`  ${pad(op, 22)}${pad(creq, 7)}${pad(cres, 7)}${pad(srv, 6)}${gap}`);
  }

  // 3) Socket health.
  const sockErr = client.filter((e) => e.op === "socket.error");
  const sockConn = client.filter((e) => e.op === "socket.connect").length;
  const srvConnected = server.filter((e) => /connected|device rooms/.test(e.msg || "")).length;
  out.push("");
  out.push("─ realtime (/secure socket) ───────────────────────────────────────────────");
  out.push(`  client connect attempts : ${sockConn}`);
  out.push(`  client connect errors   : ${sockErr.length}` +
    (sockErr.length ? `  → "${[...new Set(sockErr.map((e) => e.fields.message))].join('", "')}"` : ""));
  out.push(`  server-side connections : ${srvConnected}` +
    (sockErr.length && srvConnected === 0 ? "  ⚠ namespace rejected before handshake — realtime DOWN" : ""));

  // 4) Notable field flags.
  out.push("");
  out.push("─ flags ───────────────────────────────────────────────────────────────────");
  const cursors = client.filter((e) => e.fields.fromCursor && e.fields.fromCursor !== "0");
  for (const e of cursors) {
    out.push(`  ⚠ catch-up resumes from stale cursor ${e.fields.fromCursor} on fresh device ` +
      `${(e.deviceRowId || "?").slice(0, 8)} — a new device should start at 0; persisted cursor`);
    out.push(`    survives reload but device identity does not → can skip its own Welcome.`);
  }
  const zeroKp = client.filter((e) => e.op === "keypackages.count" && e.fields.available === "0");
  if (zeroKp.length) out.push(`  • key-packages/count returned available:0 ${zeroKp.length}× → fresh device, replenished after.`);
  if (!cursors.length && !zeroKp.length) out.push("  (none)");

  // 5) Merged timeline (server by clock; client by appearance — it emits no timestamps).
  out.push("");
  out.push("─ merged timeline ─────────────────────────────────────────────────────────");
  out.push("  (client has no timestamps → ordered by appearance; server by wall-clock)");
  const fmtTs = (e) => (e.ts ? new Date(e.ts).toISOString().slice(11, 23) : "     ·      ");
  for (const e of events) {
    const id = (e.deviceRowId || "").slice(0, 8);
    out.push(`  ${pad(fmtTs(e), 13)}${pad(e.source, 7)}${pad(e.op, 20)}${pad(e.msg || "", 34)}${id}`);
  }
  out.push("═".repeat(78));
  return out.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const ndjson = argv.includes("--ndjson");
const files = argv.filter((a) => a !== "--ndjson");
if (!files.length) {
  console.error("usage: secure-chat-log-normalize.mjs [--ndjson] <log…>   (use - for stdin)");
  process.exit(2);
}
const raw = files.map((f) => (f === "-" ? readFileSync(0, "utf8") : readFileSync(f, "utf8"))).join("\n");
const lines = raw.split("\n");
let ord = 0;
const events = [];
for (const line of lines) {
  const ev = parseLine(line, ord);
  if (ev) { ev.ord = ord++; events.push(ev); }
}
// Stable merge: server events float to their wall-clock slot; client events hold appearance order.
events.sort((a, b) => {
  if (a.ts && b.ts) return a.ts - b.ts || a.ord - b.ord;
  return a.ord - b.ord; // mixed/untimestamped: preserve capture order
});

if (ndjson) {
  for (const e of events) console.log(JSON.stringify(e));
} else {
  console.log(report(events));
}
