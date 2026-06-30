// apps/api/test/integration/connections-realtime.test.ts
// Connection request/accept now route through lib/notifications.insert(), which fires
// notification:created to the recipient's user room (auto-joined on connect). Mirrors the
// chat-realtime harness: boots a real HTTP + socket.io server so a socket.io-client connects
// over the wire; REST writes fan out via the module-global io handle.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createApp } from "../../src/app.js";
import { attachRealtime } from "../../src/realtime/socket.js";
import { api, createProject, createUser, deleteProject } from "./helpers.js";

let projectId: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachRealtime>;
let port: number;

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connectClient(`http://localhost:${port}`, {
      auth: { token }, query: { projectId }, transports: ["websocket"], reconnection: false,
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}
function once(socket: Socket, event: string, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload: unknown) => { clearTimeout(t); resolve(payload); });
  });
}

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
  bob = await createUser(projectId);
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

describe("connections realtime (socket.io e2e)", () => {
  it("delivers notification:created (connection-request) to the addressee's user room", async () => {
    const sock = await connect(bob.token); // auto-joins user:{proj}:bob
    try {
      const note = once(sock, "notification:created");
      const res = await api("POST", `/v7/users/${bob.id}/connection`, {
        token: alice.token, body: {},
      });
      expect([200, 201]).toContain(res.status);
      const evt = await note;
      expect(evt.type).toBe("connection-request");
      expect(evt.metadata.initiatorId).toBe(alice.id);
    } finally {
      sock.close();
    }
  });

  it("delivers notification:created (connection-accepted) to the requester's user room", async () => {
    // alice (requester) listens; bob accepts.
    const sock = await connect(alice.token);
    try {
      // find the pending connection id from bob's side
      const pending = await api("GET", `/v7/users/${alice.id}/connection`, { token: bob.token });
      const connId = pending.body.connectionId;
      const note = once(sock, "notification:created");
      const res = await api("PATCH", `/v7/connections/${connId}/accept`, { token: bob.token });
      expect(res.status).toBe(200);
      const evt = await note;
      expect(evt.type).toBe("connection-accepted");
      expect(evt.metadata.initiatorId).toBe(bob.id);
    } finally {
      sock.close();
    }
  });
});
