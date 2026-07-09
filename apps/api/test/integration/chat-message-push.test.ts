// apps/api/test/integration/chat-message-push.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import webpush from "web-push";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { pushDevices, projectIntegrations } from "../../src/db/schema/index.js";
import { sendChatMessagePush } from "../../src/lib/push/index.js";

describe("chat-message push fan-out (integration)", () => {
  let projectId: string; let B: string;
  let alice: { id: string; token: string };   // sender
  let bob: { id: string; token: string };      // recipient (has a device)
  let conversationId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [alice, bob] = await Promise.all([createUser(projectId), createUser(projectId)]);
    const keys = webpush.generateVAPIDKeys();
    await getDb().insert(projectIntegrations).values({
      projectId, name: "vapid",
      data: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:t@x" },
    });
    await getDb().insert(pushDevices).values({
      projectId, userId: bob.id, platform: "web",
      subscription: { endpoint: "https://push.example/bob", keys: { p256dh: "p", auth: "a" } },
    });
    const g = await api("POST", `${B}/chat/conversations`, { token: alice.token, body: { type: "group", name: "Crew", memberIds: [bob.id] } });
    conversationId = g.body.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  // Reset any mute/opt-out state bob accrued in a prior case, so cases are order-independent.
  beforeEach(async () => {
    const clearedMute = await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: bob.token, body: { duration: null } });
    expect(clearedMute.status).toBe(200);
    const clearedPrefs = await api("PUT", `${B}/push-notifications/preferences`, { token: bob.token, body: { disabledTypes: [] } });
    expect(clearedPrefs.status).toBe(200);
  });

  it("dispatches to a member who is neither muted nor opted-out", async () => {
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await sendChatMessagePush(projectId, bob.id, conversationId);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("suppresses when the recipient muted the conversation forever", async () => {
    await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: bob.token, body: { duration: "forever" } });
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await sendChatMessagePush(projectId, bob.id, conversationId);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("suppresses when the recipient has a future timed mute", async () => {
    await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: bob.token, body: { duration: "8h" } });
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await sendChatMessagePush(projectId, bob.id, conversationId);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("suppresses when the recipient globally opted out of 'message'", async () => {
    await api("PUT", `${B}/push-notifications/preferences`, { token: bob.token, body: { disabledTypes: ["message"] } });
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await sendChatMessagePush(projectId, bob.id, conversationId);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("POST /messages still succeeds with the fan-out wired in (route smoke test)", async () => {
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    const res = await api("POST", `${B}/chat/conversations/${conversationId}/messages`, { token: alice.token, body: { content: "hi crew" } });
    expect(res.status).toBe(201);
    expect(res.body.content).toBe("hi crew");
    spy.mockRestore();
  });
});
