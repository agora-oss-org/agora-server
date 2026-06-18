// Secure chat realtime — the "/secure" socket.io namespace. Boots a real HTTP+socket.io server so
// a socket.io-client can connect over the wire. Covers: ciphertext message fan-out to the
// conversation room, targeted Welcome delivery to the device room, and membership gating.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { io as connectClient, type Socket } from "socket.io-client";
import { createSecureApp } from "../../src/app.js";
import { attachSecureRealtime } from "../../src/realtime/secure-socket.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { provisionDevice, claimKeyPackage, b64e, b64d, enc } from "./secure-helpers.js";

let projectId: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };
let server: ReturnType<typeof serve>;
let io: ReturnType<typeof attachSecureRealtime>;
let port: number;

let aliceDev: Awaited<ReturnType<typeof provisionDevice>>;
let bobDev: Awaited<ReturnType<typeof provisionDevice>>;
let group: Awaited<ReturnType<typeof aliceDev.crypto.createGroup>>["group"];
let conversationId: string;

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connectClient(`http://localhost:${port}/secure`, {
      path: "/secure-socket/", // secure realtime owns its OWN engine.io path (not the default /socket.io/)
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
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
  bob = await createUser(projectId);
  const app = createSecureApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { port = info.port; resolve(); });
  });
  io = attachSecureRealtime(server as unknown as Parameters<typeof attachSecureRealtime>[0]);

  aliceDev = await provisionDevice(projectId, alice, "alice-web");
  bobDev = await provisionDevice(projectId, bob, "bob-web");
  const claim = await claimKeyPackage(projectId, alice, bobDev.rowId);
  const cg = await aliceDev.crypto.createGroup({ initialMembers: [{ deviceId: bobDev.deviceId, keyPackage: b64d(claim.keyPackage!) }] });
  group = cg.group;
  const created = await api("POST", `${base(projectId)}/secure-chat/conversations`, {
    token: alice.token,
    body: { type: "dm", mlsGroupId: b64e(group.mlsGroupId), memberUserIds: [bob.id], welcomes: [{ targetDeviceId: bobDev.rowId, payload: b64e(cg.welcomes[0]!.payload), epoch: "0" }] },
  });
  conversationId = created.body.id;
});

afterAll(async () => {
  io?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (projectId) await deleteProject(projectId);
});

describe("secure-chat realtime (/secure namespace)", () => {
  it("rejects a handshake with an invalid token", async () => {
    await expect(connect("garbage-token")).rejects.toBeTruthy();
  });

  it("fans out secure:message (ciphertext) to a joined member", async () => {
    const sock = await connect(bob.token);
    try {
      sock.emit("join:secure-conversation", { conversationId });
      await settle();
      const evt = once(sock, "secure:message");
      const { ciphertext, epoch } = await aliceDev.crypto.encryptMessage(group, enc.encode("realtime secret"));
      const sent = await api("POST", `${base(projectId)}/secure-chat/conversations/${conversationId}/messages`, {
        token: alice.token, body: { ciphertext: b64e(ciphertext), epoch: epoch.toString(), senderDeviceId: aliceDev.rowId },
      });
      expect(sent.status).toBe(201);
      const payload = await evt;
      expect(payload.id).toBe(sent.body.id);
      expect(payload.ciphertext).toBe(b64e(ciphertext)); // ciphertext only — no plaintext on the wire
      expect(payload).not.toHaveProperty("content");
    } finally {
      sock.close();
    }
  });

  it("delivers a targeted secure:welcome to the recipient's device room", async () => {
    // Connect Bob first so his device room is auto-joined, then add Carol... actually add a fresh
    // member to an existing group and assert Bob (the target of a new welcome) would get it. Here we
    // re-key: add Carol and target Bob's device with a welcome to prove device-room routing.
    const sock = await connect(bob.token);
    try {
      await settle(); // allow auto-join of bob's device room
      const welcome = once(sock, "secure:welcome");
      const carol = await createUser(projectId);
      const carolDev = await provisionDevice(projectId, carol, "carol-web");
      const claim = await claimKeyPackage(projectId, alice, carolDev.rowId);
      const commit = await aliceDev.crypto.addMember(group, { deviceId: carolDev.deviceId, keyPackage: b64d(claim.keyPackage!) });
      // Send the (re-key) Welcome to BOB's device row, exercising secure:device room routing.
      await api("POST", `${base(projectId)}/secure-chat/conversations/${conversationId}/members`, {
        token: alice.token,
        body: { userId: carol.id, commit: { payload: b64e(commit.commit), epoch: commit.epoch.toString() }, welcomes: [{ targetDeviceId: bobDev.rowId, payload: b64e(commit.welcomes[0]!.payload), epoch: commit.epoch.toString() }] },
      });
      const payload = await welcome;
      expect(payload.kind).toBe("welcome");
      expect(payload.targetDeviceId).toBe(bobDev.rowId);
    } finally {
      sock.close();
    }
  });

  it("does NOT deliver to a non-member who tries to join the conversation room", async () => {
    const carol = await createUser(projectId);
    const sock = await connect(carol.token);
    try {
      sock.emit("join:secure-conversation", { conversationId }); // silently refused (not a member)
      await settle();
      let received = false;
      sock.once("secure:message", () => { received = true; });
      const { ciphertext, epoch } = await aliceDev.crypto.encryptMessage(group, enc.encode("members only"));
      await api("POST", `${base(projectId)}/secure-chat/conversations/${conversationId}/messages`, {
        token: alice.token, body: { ciphertext: b64e(ciphertext), epoch: epoch.toString(), senderDeviceId: aliceDev.rowId },
      });
      await settle(1200);
      expect(received).toBe(false);
    } finally {
      sock.close();
    }
  });
});
