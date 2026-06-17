// Secure-chat realtime ADDRESSING contract — isolates diagnostic finding #1 ("Invalid namespace").
//
// Production symptom (from the log correlator): the SDK secure socket logs 5× `connect_error
// {message: 'Invalid namespace'}` and the server logs ZERO /secure connections — realtime is down.
//
// Root cause: socket.io derives the NAMESPACE from the connection URL's PATH. The SDK builds the
// socket as `io(`${getSocketUrl()}/secure`)`, and getSocketUrl() returns the REST base
// `http://host/v7` (the `/v7` API prefix leaks in). So the client asks for namespace `/v7/secure`,
// but the server only registered `/secure` (realtime/secure-socket.ts → `io.of("/secure")`).
//
// This test encodes the server's namespace CONTRACT and reproduces the exact failure address:
//   • `/secure`      → connects (the correct address)
//   • `/v7/secure`   → connect_error "Invalid namespace"  (what the client currently sends)
// The actual FIX is client-side (the socket origin must be the bare host, not the /v7 REST base);
// this test guards the server contract the client must address and documents the mechanism.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createApp } from "../../src/app.js";
import { attachRealtime } from "../../src/realtime/socket.js";
import { createProject, createUser, deleteProject } from "./helpers.js";

let projectId: string;
let user: { id: string; token: string };
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachRealtime>;
let port: number;

type ConnectResult = { ok: true } | { ok: false; message: string };

// Attempt a one-shot connection to the given namespace path; resolve the outcome either way.
function tryConnect(namespacePath: string, token: string): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const s: Socket = connectClient(`http://localhost:${port}${namespacePath}`, {
      auth: { token }, query: { projectId }, transports: ["websocket"], reconnection: false,
    });
    const done = (r: ConnectResult) => { s.close(); resolve(r); };
    s.on("connect", () => done({ ok: true }));
    s.on("connect_error", (e) => done({ ok: false, message: e.message }));
    setTimeout(() => done({ ok: false, message: "timeout" }), 5000);
  });
}

beforeAll(async () => {
  projectId = await createProject();
  user = await createUser(projectId);
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { port = info.port; resolve(); });
  });
  io = attachRealtime(server as unknown as Parameters<typeof attachRealtime>[0]);
});

afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("secure-chat /secure namespace addressing (finding #1)", () => {
  it("connects when addressed at exactly /secure", async () => {
    const r = await tryConnect("/secure", user.token);
    expect(r).toEqual({ ok: true });
  });

  it("is rejected with 'Invalid namespace' when the /v7 REST base leaks into the socket URL", async () => {
    // io('http://host/v7/secure') → socket.io parses the whole path as namespace '/v7/secure',
    // which the server never registered. This is the exact production failure mode.
    const r = await tryConnect("/v7/secure", user.token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/invalid namespace/i);
  });

  it("also rejects the default namespace path '/' carrying no secure handlers gracefully", async () => {
    // Sanity anchor: the MAIN namespace ('/') exists, so this connects — proving the rejection above
    // is specifically about the unregistered '/v7/secure' path, not a server-wide socket failure.
    const r = await tryConnect("/", user.token);
    expect(r).toEqual({ ok: true });
  });
});
