// Integration: comments domain depth — threaded replies via parentId (+ replies_count trigger),
// comment reactions (toggle_reaction with target=comment, no score), by-foreign-id, PATCH
// ownership, and soft-delete hiding.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("comments depth (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let other: { id: string; token: string };
  let entityId: string;
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    [owner, other] = await Promise.all([createUser(projectId), createUser(projectId)]);
    B = base(projectId);
    entityId = (await api("POST", `${B}/entities`, { token: owner.token, body: { title: "thread" } })).body.id;
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  const mkComment = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/comments`, { token, body: { entityId, ...body } });

  it("threads replies under a parent and bumps the parent's replies_count", async () => {
    const root = await mkComment(owner.token, { content: "root" });
    expect(root.status).toBe(201);
    const reply = await mkComment(other.token, { content: "reply", parentId: root.body.id });
    expect(reply.body.parentId).toBe(root.body.id);

    // top level (no parentId) shows the root, not the reply
    const top = await api("GET", `${B}/comments?entityId=${entityId}`);
    const topIds = top.body.data.map((c: any) => c.id);
    expect(topIds).toContain(root.body.id);
    expect(topIds).not.toContain(reply.body.id);

    // one level down shows the reply
    const replies = await api("GET", `${B}/comments?entityId=${entityId}&parentId=${root.body.id}`);
    expect(replies.body.data.map((c: any) => c.id)).toEqual([reply.body.id]);

    // parent.replies_count bumped by trigger
    const refetched = await api("GET", `${B}/comments/${root.body.id}`);
    expect(refetched.body.repliesCount).toBe(1);
  });

  it("toggles a comment reaction (target=comment, no score refresh)", async () => {
    const { body: comment } = await mkComment(owner.token, { content: "react to me" });

    const like = await api("POST", `${B}/comments/${comment.id}/reactions`, { token: other.token, body: { type: "like" } });
    expect(like.status).toBe(200);
    expect(like.body.reactionCounts.like).toBe(1);
    expect(like.body.userReaction).toBe("like");

    const off = await api("POST", `${B}/comments/${comment.id}/reactions`, { token: other.token, body: { type: "like" } });
    expect(off.body.reactionCounts.like).toBe(0);
    expect(off.body.userReaction).toBeNull();
  });

  it("looks up a comment by foreign id", async () => {
    const fid = `cmt_${Date.now()}`;
    const { body: created } = await mkComment(owner.token, { content: "x", foreignId: fid });
    const found = await api("GET", `${B}/comments/by-foreign-id?foreignId=${fid}`);
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(created.id);
  });

  it("enforces ownership on edit (non-owner 403, owner 200)", async () => {
    const { body: comment } = await mkComment(owner.token, { content: "mine" });
    const denied = await api("PATCH", `${B}/comments/${comment.id}`, { token: other.token, body: { content: "hijack" } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("comments/not-owner");

    const ok = await api("PATCH", `${B}/comments/${comment.id}`, { token: owner.token, body: { content: "edited" } });
    expect(ok.status).toBe(200);
    expect(ok.body.content).toBe("edited");
  });

  it("soft-deletes a comment (hidden from reads afterward)", async () => {
    const { body: comment } = await mkComment(owner.token, { content: "ephemeral" });
    const del = await api("DELETE", `${B}/comments/${comment.id}`, { token: owner.token });
    expect(del.status).toBe(200);
    const gone = await api("GET", `${B}/comments/${comment.id}`);
    expect(gone.status).toBe(404);
  });
});
