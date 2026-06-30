// E2E: chat realtime over socket.io. Unlike the other integration files (which drive the app
// purely in-process), this boots a real HTTP server + socket.io so a socket.io-client can
// connect over the wire. REST writes still go through the in-process api() helper — they fan
// out to connected sockets because emitToConversation() uses a module-global io handle.
//
// Covers: handshake auth, membership-gated room join, and message:created / message:reaction
// fan-out — the parts that must stay byte-compatible with @replyke/core's socket contract.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createApp } from "../../src/app.js";
import { attachRealtime } from "../../src/realtime/socket.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

let projectId: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachRealtime>;
let port: number;
let conversationId: string;

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

/** Resolve with the next payload for `event`, or reject after `ms`. */
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

  // alice opens a direct conversation with bob (creates the conversation + both members)
  const convo = await api("POST", `${base(projectId)}/chat/conversations/direct`, {
    token: alice.token,
    body: { userId: bob.id },
  });
  expect([200, 201]).toContain(convo.status); // 201 created, or 200 if it already exists
  conversationId = convo.body.id;
});

afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("chat realtime (socket.io e2e)", () => {
  it("rejects a socket handshake with an invalid token", async () => {
    await expect(connect("garbage-token")).rejects.toBeTruthy();
  });

  it("delivers message:created to a joined member", async () => {
    const sock = await connect(bob.token);
    try {
      sock.emit("join:conversation", { conversationId });
      await settle(); // allow the async membership check + room join

      const created = once(sock, "message:created");
      const sent = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: alice.token,
        body: { content: "hello realtime" },
      });
      expect(sent.status).toBe(201);

      const evt = await created;
      expect(evt.id).toBe(sent.body.id);
      expect(evt.content).toBe("hello realtime");
    } finally {
      sock.close();
    }
  });

  it("fans out message:reaction to the conversation room", async () => {
    const sock = await connect(bob.token);
    try {
      sock.emit("join:conversation", { conversationId });
      await settle();

      const msg = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: alice.token,
        body: { content: "react to me" },
      });

      const reaction = once(sock, "message:reaction");
      await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages/${msg.body.id}/reactions`, {
        token: bob.token,
        body: { emoji: "🔥" },
      });

      const evt = await reaction;
      expect(evt.messageId).toBe(msg.body.id);
      expect(evt.emoji).toBe("🔥");
      expect(evt.delta).toBe(1);
      expect(evt.reactionCounts["🔥"]).toBe(1);
    } finally {
      sock.close();
    }
  });

  it("does NOT deliver to a non-member who tries to join (room is membership-gated)", async () => {
    const carol = await createUser(projectId);
    const sock = await connect(carol.token);
    try {
      sock.emit("join:conversation", { conversationId }); // join is silently refused — not a member
      await settle();

      let received = false;
      sock.once("message:created", () => {
        received = true;
      });
      await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: alice.token,
        body: { content: "members only" },
      });
      await settle(1200); // give any (erroneous) delivery time to arrive

      expect(received).toBe(false);
    } finally {
      sock.close();
    }
  });

  it("delivers message:created to an inbox observer who has NOT joined the conversation room", async () => {
    // bob is a member of `conversationId` but does NOT emit join:conversation — he only has his
    // auto-joined user room. The fan-out must still reach him (the critical inbox-live fix).
    const sock = await connect(bob.token);
    try {
      const created = once(sock, "message:created");
      const sent = await api("POST", `${base(projectId)}/chat/conversations/${conversationId}/messages`, {
        token: alice.token,
        body: { content: "inbox observer ping" },
      });
      expect(sent.status).toBe(201);
      const evt = await created;
      expect(evt.id).toBe(sent.body.id);
      expect(evt.content).toBe("inbox observer ping");
    } finally {
      sock.close();
    }
  });

  it("emits conversation:created to a new direct conversation's recipient", async () => {
    // A brand-new peer so the direct create is genuine (not get-or-create early-return).
    const dave = await createUser(projectId);
    const sock = await connect(dave.token); // auto-joins user:{proj}:dave
    try {
      const created = once(sock, "conversation:created");
      const res = await api("POST", `${base(projectId)}/chat/conversations/direct`, {
        token: alice.token,
        body: { userId: dave.id },
      });
      expect(res.status).toBe(201);
      const preview = await created;
      expect(preview.id).toBe(res.body.id);
      expect(preview.unreadCount).toBe(0);
      expect(preview.lastMessage ?? null).toBeNull();
      // dave's otherMembers = [alice]
      expect(preview.otherMembers.map((m: any) => m.id)).toEqual([alice.id]);
    } finally {
      sock.close();
    }
  });
});
