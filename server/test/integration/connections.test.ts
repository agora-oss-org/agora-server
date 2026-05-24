// Integration: connections — the bidirectional friend-request state machine
// (none → pending → connected/declined) and its directional status reporting.
// These routes live at the /v7 ROOT (not under /:projectId); the project is derived from the
// authenticated user's profile.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("connections state machine (integration)", () => {
  let projectId: string;
  let alice: { id: string; token: string };
  let bob: { id: string; token: string };
  let carl: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    [alice, bob, carl] = await Promise.all([
      createUser(projectId),
      createUser(projectId),
      createUser(projectId),
    ]);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  const request = (token: string, targetId: string, message?: string) =>
    api("POST", `/v7/users/${targetId}/connection`, { token, body: message ? { message } : {} });
  const status = (token: string, targetId: string) => api("GET", `/v7/users/${targetId}/connection`, { token });

  it("rejects connecting with yourself", async () => {
    const res = await request(alice.token, alice.id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("connections/self");
  });

  it("request → pending, reported directionally to each side", async () => {
    const res = await request(alice.token, bob.id, "hey!");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");

    const fromSender = await status(alice.token, bob.id);
    expect(fromSender.body).toMatchObject({ status: "pending", type: "sent" });

    const fromReceiver = await status(bob.token, alice.id);
    expect(fromReceiver.body).toMatchObject({ status: "pending", type: "received" });

    // surfaces in each side's pending list (standard { data, pagination } envelope)
    const sent = await api("GET", `/v7/connections/pending/sent`, { token: alice.token });
    expect(sent.body.pagination.totalItems).toBe(1);
    expect(sent.body.data[0].user.id).toBe(bob.id);

    const received = await api("GET", `/v7/connections/pending/received`, { token: bob.token });
    expect(received.body.data[0].user.id).toBe(alice.id);

    // the addressee receives a connection-request notification naming the initiator
    const inbox = await api("GET", `${base(projectId)}/app-notifications`, { token: bob.token });
    const note = inbox.body.data.find((n: any) => n.type === "connection-request");
    expect(note).toBeTruthy();
    expect(note.metadata.initiatorId).toBe(alice.id);
  });

  it("a duplicate pending request is a 409", async () => {
    const dup = await request(alice.token, bob.id);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("connections/already-pending");
  });

  it("only the addressee can accept (wrong user → 404)", async () => {
    const { body: pending } = await status(alice.token, bob.id);
    const wrong = await api("PATCH", `/v7/connections/${pending.connectionId}/accept`, { token: carl.token });
    expect(wrong.status).toBe(404);
    expect(wrong.body.code).toBe("connections/not-pending");
  });

  it("accept → connected; counts and the established list update for both", async () => {
    const { body: pending } = await status(alice.token, bob.id);
    const accepted = await api("PATCH", `/v7/connections/${pending.connectionId}/accept`, { token: bob.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("connected");

    const aView = await status(alice.token, bob.id);
    expect(aView.body.status).toBe("connected");

    const aCount = await api("GET", `/v7/connections/count`, { token: alice.token });
    const bCount = await api("GET", `/v7/connections/count`, { token: bob.token });
    expect(aCount.body.count).toBe(1);
    expect(bCount.body.count).toBe(1);

    const aList = await api("GET", `/v7/connections`, { token: alice.token });
    expect(aList.body.data.map((r: any) => r.connectedUser.id)).toContain(bob.id);

    // the original requester is notified that their request was accepted
    const inbox = await api("GET", `${base(projectId)}/app-notifications`, { token: alice.token });
    const note = inbox.body.data.find((n: any) => n.type === "connection-accepted");
    expect(note).toBeTruthy();
    expect(note.metadata.initiatorId).toBe(bob.id);
  });

  it("re-requesting an already-connected user is a 409", async () => {
    const dup = await request(alice.token, bob.id);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("connections/already-connected");
  });

  it("decline → declined, reported directionally", async () => {
    const req = await request(carl.token, alice.id);
    expect(req.status).toBe(201);

    const decline = await api("PATCH", `/v7/connections/${req.body.id}/decline`, { token: alice.token });
    expect(decline.status).toBe(200);
    expect(decline.body.status).toBe("declined");

    const fromSender = await status(carl.token, alice.id);
    expect(fromSender.body).toMatchObject({ status: "declined", type: "sent" });
  });

  it("disconnecting a connected pair removes it (status → none)", async () => {
    const removed = await api("DELETE", `/v7/users/${bob.id}/connection`, { token: alice.token });
    expect(removed.status).toBe(200);
    expect(removed.body.action).toBe("disconnect");

    const after = await status(alice.token, bob.id);
    expect(after.body.status).toBe("none");
  });
});
