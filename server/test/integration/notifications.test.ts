// Integration: notification fan-out (lib/notifications.ts) against a real Postgres.
// Proves every write path writes the right app_notifications row(s) to the right recipient,
// with SDK-shaped metadata — plus the self-notify guard, milestone thresholds, and the inbox
// endpoints (list / unread count / mark-as-read / mark-all). Isolated by its own project.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("notification fan-out (integration)", () => {
  let projectId: string;
  let alice: { id: string; token: string }; // content owner
  let bob: { id: string; token: string }; // actor
  let carol: { id: string; token: string }; // third party
  let B: string; // base url

  beforeAll(async () => {
    projectId = await createProject();
    [alice, bob, carol] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  // Recipient's full inbox (newest first).
  const inbox = async (u: { token: string }) =>
    (await api("GET", `${B}/app-notifications?limit=100`, { token: u.token })).body.data as any[];
  const ofType = async (u: { token: string }, type: string) => (await inbox(u)).filter((n) => n.type === type);
  const newEntity = async (owner: { token: string }, body: Record<string, unknown> = {}) =>
    (await api("POST", `${B}/entities`, { token: owner.token, body: { title: "t", content: "c", ...body } })).body;

  it("entity-comment notifies the entity author with shaped metadata", async () => {
    const e = await newEntity(alice);
    const c = await api("POST", `${B}/comments`, { token: bob.token, body: { entityId: e.id, content: "nice post" } });
    expect(c.status).toBe(201);

    const notes = (await ofType(alice, "entity-comment")).filter((n) => n.metadata.entityId === e.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ action: "open-comment", isRead: false, userId: alice.id });
    expect(notes[0].metadata).toMatchObject({
      entityId: e.id,
      entityShortId: e.shortId,
      commentId: c.body.id,
      commentContent: "nice post",
      initiatorId: bob.id,
    });
    expect("initiatorUsername" in notes[0].metadata).toBe(true);
  });

  it("does NOT notify when the author comments on their own entity", async () => {
    const e = await newEntity(alice);
    await api("POST", `${B}/comments`, { token: alice.token, body: { entityId: e.id, content: "talking to myself" } });
    const notes = (await ofType(alice, "entity-comment")).filter((n) => n.metadata.entityId === e.id);
    expect(notes).toHaveLength(0);
  });

  it("comment-reply notifies the parent comment's author (not the entity author)", async () => {
    const e = await newEntity(alice);
    const parent = await api("POST", `${B}/comments`, { token: bob.token, body: { entityId: e.id, content: "parent" } });
    const reply = await api("POST", `${B}/comments`, {
      token: carol.token,
      body: { entityId: e.id, parentId: parent.body.id, content: "reply!" },
    });
    expect(reply.status).toBe(201);

    const notes = (await ofType(bob, "comment-reply")).filter((n) => n.metadata.replyId === reply.body.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ action: "open-comment", userId: bob.id });
    expect(notes[0].metadata).toMatchObject({
      entityId: e.id,
      commentId: parent.body.id,
      commentContent: "parent",
      replyId: reply.body.id,
      replyContent: "reply!",
      initiatorId: carol.id,
    });
  });

  it("comment-mention notifies mentioned users", async () => {
    const e = await newEntity(alice);
    const c = await api("POST", `${B}/comments`, {
      token: bob.token,
      body: { entityId: e.id, content: "hey @carol", mentions: [{ id: carol.id }] },
    });
    const notes = (await ofType(carol, "comment-mention")).filter((n) => n.metadata.commentId === c.body.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ action: "open-comment", userId: carol.id });
    expect(notes[0].metadata).toMatchObject({ entityId: e.id, commentId: c.body.id, initiatorId: bob.id });
  });

  it("dedupes: a comment mentioning the entity author yields entity-comment only (no comment-mention)", async () => {
    const e = await newEntity(alice);
    const c = await api("POST", `${B}/comments`, {
      token: bob.token,
      body: { entityId: e.id, content: "ping @alice", mentions: [{ id: alice.id }] },
    });
    const comments = (await ofType(alice, "entity-comment")).filter((n) => n.metadata.commentId === c.body.id);
    const mentions = (await ofType(alice, "comment-mention")).filter((n) => n.metadata.commentId === c.body.id);
    expect(comments).toHaveLength(1);
    expect(mentions).toHaveLength(0);
  });

  it("entity-mention notifies mentioned users on entity creation", async () => {
    const e = await newEntity(alice, { mentions: [{ id: bob.id }] });
    const notes = (await ofType(bob, "entity-mention")).filter((n) => n.metadata.entityId === e.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ action: "open-entity", userId: bob.id });
    expect(notes[0].metadata).toMatchObject({ entityId: e.id, entityShortId: e.shortId, initiatorId: alice.id });
  });

  it("entity reaction: upvote→entity-upvote, love→entity-reaction; fires on add, NOT on toggle-off", async () => {
    const e = await newEntity(alice);

    await api("POST", `${B}/entities/${e.id}/reactions`, { token: bob.token, body: { type: "upvote" } });
    let up = (await ofType(alice, "entity-upvote")).filter((n) => n.metadata.entityId === e.id);
    expect(up).toHaveLength(1);
    expect(up[0].metadata.initiatorId).toBe(bob.id);

    // toggle the same reaction off → no new notification
    await api("POST", `${B}/entities/${e.id}/reactions`, { token: bob.token, body: { type: "upvote" } });
    up = (await ofType(alice, "entity-upvote")).filter((n) => n.metadata.entityId === e.id);
    expect(up).toHaveLength(1); // unchanged

    // a non-upvote reaction → entity-reaction carrying reactionType
    await api("POST", `${B}/entities/${e.id}/reactions`, { token: bob.token, body: { type: "love" } });
    const react = (await ofType(alice, "entity-reaction")).filter((n) => n.metadata.entityId === e.id);
    expect(react).toHaveLength(1);
    expect(react[0].metadata).toMatchObject({ reactionType: "love", initiatorId: bob.id });
  });

  it("comment reaction notifies the comment author (comment-upvote)", async () => {
    const e = await newEntity(alice);
    const c = await api("POST", `${B}/comments`, { token: bob.token, body: { entityId: e.id, content: "react to me" } });
    await api("POST", `${B}/comments/${c.body.id}/reactions`, { token: carol.token, body: { type: "upvote" } });
    const notes = (await ofType(bob, "comment-upvote")).filter((n) => n.metadata.commentId === c.body.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ action: "open-comment", userId: bob.id });
    expect(notes[0].metadata).toMatchObject({ commentId: c.body.id, entityId: e.id, initiatorId: carol.id });
  });

  it("reaction milestones: 10 upvotes emit milestone-specific + milestone-total", async () => {
    const e = await newEntity(alice);
    const reactors = await Promise.all(Array.from({ length: 10 }, () => createUser(projectId)));
    // sequential so exactly one reaction observes count === 10 (the threshold)
    for (const r of reactors) {
      await api("POST", `${B}/entities/${e.id}/reactions`, { token: r.token, body: { type: "upvote" } });
    }

    const specific = (await ofType(alice, "entity-reaction-milestone-specific")).filter((n) => n.metadata.entityId === e.id);
    expect(specific).toHaveLength(1);
    expect(specific[0].metadata).toMatchObject({ reactionType: "upvote", milestoneCount: 10 });
    expect(Array.isArray(specific[0].metadata.lastThreeUsers)).toBe(true);
    expect(specific[0].metadata.lastThreeUsers.length).toBe(3);

    const total = (await ofType(alice, "entity-reaction-milestone-total")).filter((n) => n.metadata.entityId === e.id);
    expect(total).toHaveLength(1);
    expect(total[0].metadata.milestoneCount).toBe(10);
    expect(total[0].metadata.reactionCounts.upvote).toBe(10);
  });

  it("new-follow notifies the followed user, and only on a fresh follow", async () => {
    await api("DELETE", `${B}/users/${alice.id}/follow`, { token: bob.token }); // clean slate
    const before = (await ofType(alice, "new-follow")).length;

    await api("POST", `${B}/users/${alice.id}/follow`, { token: bob.token });
    expect((await ofType(alice, "new-follow")).length).toBe(before + 1);

    // re-following while already following must NOT notify again
    await api("POST", `${B}/users/${alice.id}/follow`, { token: bob.token });
    expect((await ofType(alice, "new-follow")).length).toBe(before + 1);

    const note = (await ofType(alice, "new-follow")).find((n) => n.metadata.initiatorId === bob.id);
    expect(note).toMatchObject({ action: "open-profile", userId: alice.id });
  });

  it("space-membership-approved notifies the approved member", async () => {
    const space = await api("POST", `${B}/spaces`, {
      token: alice.token,
      body: { name: "Gated", requireJoinApproval: true },
    });
    expect(space.status).toBe(201);
    const join = await api("POST", `${B}/spaces/${space.body.id}/join`, { token: bob.token });
    expect(join.body.membership.status).toBe("pending");

    const approve = await api("PATCH", `${B}/spaces/${space.body.id}/members/${bob.id}/approve`, { token: alice.token });
    expect(approve.body.membership.status).toBe("active");

    const notes = (await ofType(bob, "space-membership-approved")).filter((n) => n.metadata.spaceId === space.body.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ action: "open-space", userId: bob.id });
    expect(notes[0].metadata).toMatchObject({ spaceId: space.body.id, spaceName: "Gated", spaceShortId: space.body.shortId });
  });

  it("inbox plumbing: list, unread count, mark-as-read, mark-all-as-read", async () => {
    // dedicated recipient so counts are deterministic
    const dave = await createUser(projectId);
    const e1 = await newEntity(dave);
    const e2 = await newEntity(dave);
    await api("POST", `${B}/entities/${e1.id}/reactions`, { token: alice.token, body: { type: "upvote" } });
    await api("POST", `${B}/entities/${e2.id}/reactions`, { token: bob.token, body: { type: "upvote" } });

    const list = await api("GET", `${B}/app-notifications`, { token: dave.token });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    expect(list.body.pagination.totalItems).toBeGreaterThanOrEqual(2);

    let count = await api("GET", `${B}/app-notifications/count`, { token: dave.token });
    expect(count.body.count).toBeGreaterThanOrEqual(2);

    // mark one as read → unread count drops by 1
    const before = count.body.count;
    const first = list.body.data[0];
    const marked = await api("PATCH", `${B}/app-notifications/${first.id}/mark-as-read`, { token: dave.token });
    expect(marked.body).toMatchObject({ id: first.id, isRead: true });
    count = await api("GET", `${B}/app-notifications/count`, { token: dave.token });
    expect(count.body.count).toBe(before - 1);

    // marking someone else's notification is a no-op 404
    const notMine = await api("PATCH", `${B}/app-notifications/${first.id}/mark-as-read`, { token: bob.token });
    expect(notMine.status).toBe(404);

    // mark all → unread 0
    await api("POST", `${B}/app-notifications/mark-all-as-read`, { token: dave.token });
    count = await api("GET", `${B}/app-notifications/count`, { token: dave.token });
    expect(count.body.count).toBe(0);
  });
});
