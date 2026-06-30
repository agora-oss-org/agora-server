import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("chat messages ?after= reconnect cursor (integration)", () => {
  let projectId: string; let B: string;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let convId: string;
  let ts1: string; // createdAt of the first message

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [alice, bob] = await Promise.all([createUser(projectId), createUser(projectId)]);
    const d = await api("POST", `${B}/chat/conversations/direct`, { token: alice.token, body: { userId: bob.id } });
    convId = d.body.id;
    const m1 = await api("POST", `${B}/chat/conversations/${convId}/messages`, { token: alice.token, body: { content: "first" } });
    ts1 = m1.body.createdAt;
    // ensure a strictly-later timestamp for the next two
    await new Promise((r) => setTimeout(r, 1100));
    await api("POST", `${B}/chat/conversations/${convId}/messages`, { token: alice.token, body: { content: "second" } });
    await api("POST", `${B}/chat/conversations/${convId}/messages`, { token: alice.token, body: { content: "third" } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("returns only messages created strictly after the cursor, in ascending order", async () => {
    const res = await api("GET", `${B}/chat/conversations/${convId}/messages?after=${encodeURIComponent(ts1)}&sort=asc&limit=100`, { token: bob.token });
    expect(res.status).toBe(200);
    const contents = res.body.messages.map((m: any) => m.content);
    expect(contents).toEqual(["second", "third"]); // "first" excluded (strictly after), ascending
  });

  it("rejects a malformed after timestamp with a clean 400 (not a Postgres 500)", async () => {
    const res = await api("GET", `${B}/chat/conversations/${convId}/messages?after=not-a-date`, { token: bob.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("chat/invalid-after");
  });
});
