// E2E: chat depth — the parts of the chat domain beyond the basic message:created/reaction
// fan-out covered by chat-realtime.test.ts. Boots a real HTTP + socket.io server (REST writes
// fan out to connected sockets via the module-global io handle) so we can assert the full
// durable event contract (docs/MANIFEST.md §4):
//   message:updated / message:deleted, member:joined / member:left, conversation:updated /
//   conversation:deleted, thread:reply_count, typing:start / typing:stop relay.
// Plus REST-level depth: group conversations + roles, posting permission, author-only
// edit/delete (403), non-member POST (403), admin-only delete (403), and read-state unread counts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createApp } from "../../src/app.js";
import { attachRealtime } from "../../src/realtime/socket.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

let projectId: string;
let B: string;
let alice: { id: string; token: string }; // group creator → admin
let bob: { id: string; token: string };   // member
let carol: { id: string; token: string }; // not a member
let dave: { id: string; token: string };  // added/removed for member events
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachRealtime>;
let port: number;
let aliceSock: Socket;
let bobSock: Socket;
let mainConvo: string; // group: alice (admin) + bob (member)

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

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const send = (convo: string, token: string, body: Record<string, unknown>) =>
  api("POST", `${B}/chat/conversations/${convo}/messages`, { token, body });

beforeAll(async () => {
  projectId = await createProject();
  B = base(projectId);
  [alice, bob, carol, dave] = await Promise.all([
    createUser(projectId), createUser(projectId), createUser(projectId), createUser(projectId),
  ]);

  const app = createApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { port = info.port; resolve(); });
  });
  io = attachRealtime(server as unknown as Parameters<typeof attachRealtime>[0]);

  const created = await api("POST", `${B}/chat/conversations`, {
    token: alice.token,
    body: { type: "group", name: "Depth Crew", memberIds: [bob.id] },
  });
  expect(created.status).toBe(201);
  mainConvo = created.body.id;

  [aliceSock, bobSock] = await Promise.all([connect(alice.token), connect(bob.token)]);
  aliceSock.emit("join:conversation", { conversationId: mainConvo });
  bobSock.emit("join:conversation", { conversationId: mainConvo });
  await settle(); // allow the async membership check + room join
});

afterAll(async () => {
  aliceSock?.close();
  bobSock?.close();
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("chat depth (socket.io e2e + REST)", () => {
  it("creates a group conversation: creator is admin, supplied users are members", async () => {
    const created = await api("POST", `${B}/chat/conversations`, {
      token: alice.token, body: { type: "group", name: "Roles", memberIds: [bob.id] },
    });
    expect(created.body.type).toBe("group");
    expect(created.body.memberCount).toBe(2);

    const asAdmin = await api("GET", `${B}/chat/conversations/${created.body.id}`, { token: alice.token });
    expect(asAdmin.body.currentMember.role).toBe("admin");
    const asMember = await api("GET", `${B}/chat/conversations/${created.body.id}`, { token: bob.token });
    expect(asMember.body.currentMember.role).toBe("member");
  });

  it("enforces admins-only posting permission", async () => {
    const convo = (await api("POST", `${B}/chat/conversations`, {
      token: alice.token, body: { type: "group", name: "Locked", memberIds: [bob.id], postingPermission: "admins" },
    })).body;

    const denied = await send(convo.id, bob.token, { content: "can I speak?" });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("chat/posting-restricted");

    const ok = await send(convo.id, alice.token, { content: "admins only" });
    expect(ok.status).toBe(201);
  });

  it("rejects a message from a non-member (403)", async () => {
    const r = await send(mainConvo, carol.token, { content: "let me in" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("chat/not-a-member");
  });

  it("edits a message: author-only, sets editedAt, fans out message:updated", async () => {
    const msg = (await send(mainConvo, alice.token, { content: "typo here" })).body;

    const denied = await api("PATCH", `${B}/chat/conversations/${mainConvo}/messages/${msg.id}`, {
      token: bob.token, body: { content: "hijacked" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("chat/not-author");

    const evt = once(bobSock, "message:updated");
    const ok = await api("PATCH", `${B}/chat/conversations/${mainConvo}/messages/${msg.id}`, {
      token: alice.token, body: { content: "fixed" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.content).toBe("fixed");
    expect(ok.body.editedAt).not.toBeNull();

    const payload = await evt;
    expect(payload).toMatchObject({ messageId: msg.id, conversationId: mainConvo, content: "fixed" });
    expect(payload.editedAt).toBeTruthy();
  });

  it("soft-deletes a message: author-only, fans out message:deleted with userDeletedAt", async () => {
    const msg = (await send(mainConvo, alice.token, { content: "delete me" })).body;

    const denied = await api("DELETE", `${B}/chat/conversations/${mainConvo}/messages/${msg.id}`, { token: bob.token });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("chat/not-author");

    const evt = once(bobSock, "message:deleted");
    const ok = await api("DELETE", `${B}/chat/conversations/${mainConvo}/messages/${msg.id}`, { token: alice.token });
    expect(ok.status).toBe(200);

    const payload = await evt;
    expect(payload).toMatchObject({ messageId: msg.id, conversationId: mainConvo });
    expect(payload.userDeletedAt).toBeTruthy();
  });

  it("fans out thread:reply_count when a threaded reply is posted", async () => {
    const root = (await send(mainConvo, alice.token, { content: "root of a thread" })).body;

    const evt = once(bobSock, "thread:reply_count");
    const reply = await send(mainConvo, bob.token, { content: "a reply", parentMessageId: root.id });
    expect(reply.status).toBe(201);
    expect(reply.body.parentMessageId).toBe(root.id);

    const payload = await evt;
    expect(payload).toMatchObject({ messageId: root.id, conversationId: mainConvo, threadReplyCount: 1 });
  });

  it("relays typing:start / typing:stop to other members (excludes the sender)", async () => {
    const start = once(aliceSock, "typing:start");
    bobSock.emit("typing:start", { conversationId: mainConvo });
    expect(await start).toMatchObject({ userId: bob.id, conversationId: mainConvo });

    const stop = once(aliceSock, "typing:stop");
    bobSock.emit("typing:stop", { conversationId: mainConvo });
    expect(await stop).toMatchObject({ userId: bob.id, conversationId: mainConvo });
  });

  it("fans out member:joined on add and member:left on remove (admin-gated)", async () => {
    const joined = once(bobSock, "member:joined");
    const add = await api("POST", `${B}/chat/conversations/${mainConvo}/members`, {
      token: alice.token, body: { userId: dave.id },
    });
    expect(add.status).toBe(201);
    expect((await joined).member.userId).toBe(dave.id);

    // a non-admin cannot add members
    const denied = await api("POST", `${B}/chat/conversations/${mainConvo}/members`, {
      token: bob.token, body: { userId: carol.id },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("chat/not-admin");

    const left = once(bobSock, "member:left");
    const remove = await api("DELETE", `${B}/chat/conversations/${mainConvo}/members/${dave.id}`, { token: alice.token });
    expect(remove.status).toBe(200);
    expect(await left).toMatchObject({ conversationId: mainConvo, userId: dave.id });
  });

  it("fans out conversation:updated on an admin rename", async () => {
    const evt = once(bobSock, "conversation:updated");
    const r = await api("PATCH", `${B}/chat/conversations/${mainConvo}`, {
      token: alice.token, body: { name: "Renamed Crew" },
    });
    expect(r.status).toBe(200);
    expect(await evt).toMatchObject({ id: mainConvo, name: "Renamed Crew" });
  });

  it("leave fires member:left for the departing user", async () => {
    const convo = (await api("POST", `${B}/chat/conversations`, {
      token: alice.token, body: { type: "group", name: "Leavable", memberIds: [bob.id] },
    })).body;
    aliceSock.emit("join:conversation", { conversationId: convo.id });
    await settle();

    const left = once(aliceSock, "member:left");
    const r = await api("DELETE", `${B}/chat/conversations/${convo.id}/leave`, { token: bob.token });
    expect(r.status).toBe(200);
    expect(await left).toMatchObject({ conversationId: convo.id, userId: bob.id });
  });

  it("tracks unread count and resets it on read", async () => {
    const convo = (await api("POST", `${B}/chat/conversations`, {
      token: alice.token, body: { type: "group", name: "Unread", memberIds: [bob.id] },
    })).body;
    await send(convo.id, alice.token, { content: "one" });
    await send(convo.id, alice.token, { content: "two" });

    const findConvo = async (token: string) => {
      const list = await api("GET", `${B}/chat/conversations`, { token });
      return list.body.data.find((co: any) => co.id === convo.id);
    };

    expect((await findConvo(bob.token)).unreadCount).toBe(2);

    const read = await api("POST", `${B}/chat/conversations/${convo.id}/read`, { token: bob.token });
    expect(read.status).toBe(200);
    expect((await findConvo(bob.token)).unreadCount).toBe(0);
  });

  it("admin-only delete fans out conversation:deleted", async () => {
    const convo = (await api("POST", `${B}/chat/conversations`, {
      token: alice.token, body: { type: "group", name: "Doomed", memberIds: [bob.id] },
    })).body;
    aliceSock.emit("join:conversation", { conversationId: convo.id });
    await settle();

    const denied = await api("DELETE", `${B}/chat/conversations/${convo.id}`, { token: bob.token });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("chat/not-admin");

    const evt = once(aliceSock, "conversation:deleted");
    const ok = await api("DELETE", `${B}/chat/conversations/${convo.id}`, { token: alice.token });
    expect(ok.status).toBe(200);
    expect(await evt).toMatchObject({ conversationId: convo.id });

    // gone afterward
    const gone = await api("GET", `${B}/chat/conversations/${convo.id}`, { token: alice.token });
    expect(gone.status).toBe(404);
  });
});
