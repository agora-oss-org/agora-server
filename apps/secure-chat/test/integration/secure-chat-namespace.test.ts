// Secure-chat realtime ADDRESSING contract (post-split).
//
// @agora/secure-chat runs in its OWN process, so its realtime is its OWN socket.io server on a DISTINCT
// engine.io PATH — "/secure-socket/" — NOT the default "/socket.io/" that @agora/api uses. The namespace
// stays "/secure". socket.io derives the namespace from the connection URL's path and the engine.io
// transport from the `path` option, so a client MUST address BOTH correctly:
//
//   io(`${origin}/secure`, { path: "/secure-socket/" })   → connects (the correct address)
//   io(`${origin}/secure`)  // default /socket.io/ path     → fails (no socket server there)
//   io(`${origin}/v7/secure`, { path: "/secure-socket/" }) → connect_error "Invalid namespace"
//
// This test encodes that contract. The corresponding SDK change (the secure client must target the
// secure-chat origin + path:"/secure-socket/" + namespace "/secure") lives in the separate ../agora-sdk
// repo; see docs/MANIFEST.md §4 + docs/SECURE_CHAT.md.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createSecureApp } from "../../src/app.js";
import { attachSecureRealtime } from "../../src/realtime/secure-socket.js";
import { createProject, createUser, deleteProject } from "./helpers.js";

const SECURE_PATH = "/secure-socket/";

let projectId: string;
let user: { id: string; token: string };
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachSecureRealtime>;
let port: number;

type ConnectResult = { ok: true } | { ok: false; message: string };

// Attempt a one-shot connection to the given namespace + engine.io path; resolve the outcome either way.
function tryConnect(namespacePath: string, enginePath: string | undefined, token: string): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const s: Socket = connectClient(`http://localhost:${port}${namespacePath}`, {
      ...(enginePath ? { path: enginePath } : {}),
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
  const app = createSecureApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { port = info.port; resolve(); });
  });
  io = attachSecureRealtime(server as unknown as Parameters<typeof attachSecureRealtime>[0]);
});

afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("secure-chat /secure namespace addressing (path-split)", () => {
  it("connects when addressed at namespace /secure on the /secure-socket/ path", async () => {
    const r = await tryConnect("/secure", SECURE_PATH, user.token);
    expect(r).toEqual({ ok: true });
  });

  it("is rejected with 'Invalid namespace' when the /v7 REST base leaks into the namespace", async () => {
    // io('http://host/v7/secure', { path: '/secure-socket/' }) → namespace parsed as '/v7/secure',
    // which the server never registered. Guards the SDK against re-deriving the namespace from the
    // /v7 REST base instead of the bare origin.
    const r = await tryConnect("/v7/secure", SECURE_PATH, user.token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/invalid namespace/i);
  });

  it("does NOT connect on the default /socket.io/ path — the secure server is only on /secure-socket/", async () => {
    // Omitting `path` makes socket.io-client use the default '/socket.io/', where this process serves
    // no socket server (only the Hono app). Proves the engine.io path is the routable split point a
    // reverse proxy keys on.
    const r = await tryConnect("/secure", undefined, user.token);
    expect(r.ok).toBe(false);
  });
});
