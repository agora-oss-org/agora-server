// apps/api/test/integration/conversation-mute.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("conversation mute (integration)", () => {
  let projectId: string; let B: string;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let conversationId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [alice, bob] = await Promise.all([createUser(projectId), createUser(projectId)]);
    const g = await api("POST", `${B}/chat/conversations`, { token: alice.token, body: { type: "group", name: "Crew", memberIds: [bob.id] } });
    conversationId = g.body.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("forever → mutedForever true, mutedUntil null on the caller's row", async () => {
    const res = await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: alice.token, body: { duration: "forever" } });
    expect(res.status).toBe(200);
    expect(res.body.currentMember.mutedForever).toBe(true);
    expect(res.body.currentMember.mutedUntil).toBeNull();
  });

  it("timed mute sets a future mutedUntil, mutedForever false", async () => {
    const res = await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: alice.token, body: { duration: "8h" } });
    expect(res.status).toBe(200);
    expect(res.body.currentMember.mutedForever).toBe(false);
    expect(new Date(res.body.currentMember.mutedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("null clears the mute", async () => {
    await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: alice.token, body: { duration: "forever" } });
    const res = await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: alice.token, body: { duration: null } });
    expect(res.status).toBe(200);
    expect(res.body.currentMember.mutedForever).toBe(false);
    expect(res.body.currentMember.mutedUntil).toBeNull();
  });

  it("only the caller's row is affected — the other member's mute state is untouched", async () => {
    await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: alice.token, body: { duration: "forever" } });
    const members = await api("GET", `${B}/chat/conversations/${conversationId}/members`, { token: bob.token });
    const bobRow = members.body.data.find((m: any) => m.userId === bob.id);
    expect(bobRow.mutedForever).toBe(false);
    expect(bobRow.mutedUntil).toBeNull();
  });

  it("a non-member is rejected with 403", async () => {
    const stranger = await createUser(projectId);
    const res = await api("POST", `${B}/chat/conversations/${conversationId}/mute`, { token: stranger.token, body: { duration: "8h" } });
    expect(res.status).toBe(403);
  });
});
