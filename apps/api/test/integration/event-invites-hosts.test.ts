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
