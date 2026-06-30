// apps/api/test/integration/chat-preview.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversations, conversationMembers } from "../../src/db/schema/index.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("chat conversation preview (integration)", () => {
  let projectId: string; let B: string;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let carol: { id: string; token: string };
  let groupId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [alice, bob, carol] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    // alice creates a group with bob + carol
    const g = await api("POST", `${B}/chat/conversations`, { token: alice.token, body: { type: "group", name: "Crew", memberIds: [bob.id, carol.id] } });
    groupId = g.body.id;
    // alice sends a long message so lastMessage truncation is observable
    await api("POST", `${B}/chat/conversations/${groupId}/messages`, { token: alice.token, body: { content: "z".repeat(150) } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("preview returns unreadCount, otherMembers (≤5, non-self), and a truncated lastMessage", async () => {
    const res = await api("GET", `${B}/chat/conversations/${groupId}/preview`, { token: bob.token });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(groupId);
    expect(typeof res.body.unreadCount).toBe("number");
    // bob's otherMembers = alice + carol (self excluded)
    const ids = res.body.otherMembers.map((m: any) => m.id).sort();
    expect(ids).toEqual([alice.id, carol.id].sort());
    expect(res.body.otherMembers.some((m: any) => m.id === bob.id)).toBe(false);
    expect((res.body.lastMessage.content as string).length).toBe(100);
  });

  it("list endpoint carries the preview shape (otherMembers + truncated lastMessage)", async () => {
    const res = await api("GET", `${B}/chat/conversations?limit=10`, { token: bob.token });
    expect(res.status).toBe(200);
    const row = res.body.conversations.find((x: any) => x.id === groupId);
    expect(Array.isArray(row.otherMembers)).toBe(true);
    expect((row.lastMessage.content as string).length).toBe(100);
  });

  it("otherMembers is empty for a space conversation", async () => {
    // Insert a space-type conversation directly + add bob as a member (bypassing the space plumbing).
    const [sc] = await db.insert(conversations).values({ projectId, type: "space", createdById: bob.id }).returning();
    await db.insert(conversationMembers).values({ projectId, conversationId: sc!.id, userId: bob.id, role: "member" });
    const res = await api("GET", `${B}/chat/conversations/${sc!.id}/preview`, { token: bob.token });
    expect(res.status).toBe(200);
    expect(res.body.otherMembers).toEqual([]);
    await db.delete(conversations).where(eq(conversations.id, sc!.id));
  });

  it("a non-member gets 403 on /preview", async () => {
    const stranger = await createUser(projectId);
    const res = await api("GET", `${B}/chat/conversations/${groupId}/preview`, { token: stranger.token });
    expect(res.status).toBe(403);
  });
});
