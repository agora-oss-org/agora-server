import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("event invites + hosts (integration)", () => {
  let projectId: string; let B: string;
  let host: { id: string; token: string };
  let cohost: { id: string; token: string };
  let guest: { id: string; token: string };
  let stranger: { id: string; token: string };
  let eventId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [host, cohost, guest, stranger] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId), createUser(projectId)]);
    eventId = (await api("POST", `${B}/events`, { token: host.token, body: { title: "Invite-only", startTime: "2026-07-01T18:00:00Z", type: "online", visibility: "invite" } })).body.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("non-invitee cannot view an invite-only event (403)", async () => {
    expect((await api("GET", `${B}/events/${eventId}`, { token: stranger.token })).status).toBe(403);
  });

  it("host invites a guest (idempotent); guest can now view", async () => {
    expect((await api("POST", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: guest.id } })).status).toBe(200);
    expect((await api("POST", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: guest.id } })).status).toBe(200); // idempotent
    expect((await api("GET", `${B}/events/${eventId}`, { token: guest.token })).status).toBe(200);
  });

  it("non-host cannot list invites (403)", async () => {
    expect((await api("GET", `${B}/events/${eventId}/invites`, { token: stranger.token })).status).toBe(403);
  });

  it("host adds a co-host; co-host can then manage", async () => {
    expect((await api("POST", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: cohost.id } })).body.hostIds).toContain(cohost.id);
    expect((await api("PATCH", `${B}/events/${eventId}`, { token: cohost.token, body: { title: "Renamed by cohost" } })).status).toBe(200);
  });

  it("removing the last host is rejected (400)", async () => {
    await api("DELETE", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: cohost.id } });
    const res = await api("DELETE", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: host.id } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/last-host");
  });

  it("removing an invite drops the invitee's RSVP + access", async () => {
    await api("POST", `${B}/events/${eventId}/rsvp`, { token: guest.token, body: { status: "going" } });
    await api("DELETE", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: guest.id } });
    expect((await api("GET", `${B}/events/${eventId}`, { token: guest.token })).status).toBe(403);
  });
});

describe("event host/invite userId validation (integration)", () => {
  let projectId: string; let foreignProjectId: string; let B: string;
  let host: { id: string; token: string };
  let foreignUser: { id: string; token: string }; // a real profile, but in ANOTHER project
  let eventId: string;
  // A well-formed uuid that matches no profile row.
  const BOGUS = "00000000-0000-4000-8000-000000000000";

  beforeAll(async () => {
    [projectId, foreignProjectId] = await Promise.all([createProject(), createProject()]);
    B = base(projectId);
    [host, foreignUser] = await Promise.all([createUser(projectId), createUser(foreignProjectId)]);
    eventId = (await api("POST", `${B}/events`, { token: host.token, body: { title: "Guarded", startTime: "2026-07-01T18:00:00Z", type: "online", visibility: "public" } })).body.id;
  });
  afterAll(async () => { await Promise.all([projectId && deleteProject(projectId), foreignProjectId && deleteProject(foreignProjectId)].filter(Boolean)); });

  it("POST /invites rejects a non-existent user with 400 (not a raw FK 500)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: BOGUS } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/invalid-user");
  });

  it("POST /invites rejects a cross-project profile id (no cross-tenant leak)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: foreignUser.id } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/invalid-user");
  });

  it("POST /hosts rejects a non-existent user with 400 (not a raw FK 500)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: BOGUS } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/invalid-user");
  });

  it("POST /hosts rejects a cross-project profile id (no cross-tenant leak)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: foreignUser.id } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/invalid-user");
  });

  it("create rejects a cross-project hostId with 400 and leaves no orphan event", async () => {
    const res = await api("POST", `${B}/events`, { token: host.token, body: { title: "Bad hosts", startTime: "2026-07-01T18:00:00Z", type: "online", hostIds: [foreignUser.id] } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/invalid-user");
    // The check runs before the event insert → the event must not have been created.
    const list = await api("GET", `${B}/events`, { token: host.token });
    expect(list.body.data.some((e: { title: string }) => e.title === "Bad hosts")).toBe(false);
  });

  it("still accepts a valid in-project user as invite + host", async () => {
    const member = await createUser(projectId);
    expect((await api("POST", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: member.id } })).status).toBe(200);
    expect((await api("POST", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: member.id } })).body.hostIds).toContain(member.id);
  });
});
