// E2E: app-notification realtime over socket.io. Boots a real HTTP server + socket.io so a
// socket.io-client can connect over the wire, then drives a REST comment write through the
// in-process api() helper and asserts the recipient's socket gets `notification:created`
// (and the actor's socket does not).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createApp } from "../../src/app.js";
import { attachRealtime } from "../../src/realtime/socket.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

let projectId: string;
let alice: { id: string; token: string }; // entity owner / recipient
let bob: { id: string; token: string };   // commenter / actor
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachRealtime>;
let port: number;

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connectClient(`http://localhost:${port}`, {
      auth: { token },
      query: { projectId },
      transports: ["websocket"],
      reconnection: false,
    });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

function once(socket: Socket, event: string, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload: unknown) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
  bob = await createUser(projectId);

  const app = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      port = info.port;
      resolve();
    });
  });
  io = attachRealtime(server as unknown as Parameters<typeof attachRealtime>[0]);
});

afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("notification realtime (socket.io e2e)", () => {
  it("delivers notification:created to the recipient's socket when someone comments", async () => {
    const aliceSocket = await connect(alice.token);
    try {
      // alice's socket auto-joins user:<projectId>:<alice.id> on connect — give it a beat.
      await settle(200);
      const waiter = once(aliceSocket, "notification:created");

      const e = await api("POST", `${base(projectId)}/entities`, { token: alice.token, body: { title: "t", content: "c" } });
      const c = await api("POST", `${base(projectId)}/comments`, { token: bob.token, body: { entityId: e.body.id, content: "live!" } });
      expect(c.status).toBe(201);

      const note = await waiter;
      expect(note).toMatchObject({
        userId: alice.id,
        type: "entity-comment",
        isRead: false,
      });
      expect(note.metadata).toMatchObject({ entityId: e.body.id, commentId: c.body.id, initiatorId: bob.id });
    } finally {
      aliceSocket.close();
    }
  });

  it("does NOT deliver to the actor's own socket (self-notify suppression)", async () => {
    const bobSocket = await connect(bob.token);
    try {
      await settle(200);
      let received = false;
      bobSocket.on("notification:created", () => { received = true; });

      // bob comments on his OWN entity → no notification row, nothing emitted to bob.
      const e = await api("POST", `${base(projectId)}/entities`, { token: bob.token, body: { title: "t", content: "c" } });
      await api("POST", `${base(projectId)}/comments`, { token: bob.token, body: { entityId: e.body.id, content: "mine" } });

      await settle(600);
      expect(received).toBe(false);
    } finally {
      bobSocket.close();
    }
  });
});
