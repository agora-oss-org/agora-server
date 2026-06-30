import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("event RSVPs (integration)", () => {
  let projectId: string; let B: string;
  let host: { id: string; token: string };
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let eventId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [host, a, b] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    eventId = (await api("POST", `${B}/events`, { token: host.token, body: { title: "Capped", startTime: "2026-07-01T18:00:00Z", type: "online", capacity: 1, allowMaybe: false } })).body.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("sets a going RSVP (upsert) and bumps the count", async () => {
    const res = await api("POST", `${B}/events/${eventId}/rsvp`, { token: a.token, body: { status: "going" } });
    expect(res.status).toBe(200);
    expect(res.body.rsvpCounts.going).toBe(1);
  });

  it("rejects a 2nd going past capacity 1 (400)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/rsvp`, { token: b.token, body: { status: "going" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/capacity-full");
  });

  it("rejects maybe when allowMaybe is false (400)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/rsvp`, { token: b.token, body: { status: "maybe" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/maybe-not-allowed");
  });

  it("withdraws an RSVP, freeing the seat", async () => {
    expect((await api("DELETE", `${B}/events/${eventId}/rsvp`, { token: a.token })).body.rsvpCounts.going).toBe(0);
    expect((await api("POST", `${B}/events/${eventId}/rsvp`, { token: b.token, body: { status: "going" } })).status).toBe(200);
  });

  it("lists RSVPs for the host", async () => {
    const res = await api("GET", `${B}/events/${eventId}/rsvps`, { token: host.token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("rejects an unknown ?status filter with a clean 400 (not a Postgres 500)", async () => {
    const res = await api("GET", `${B}/events/${eventId}/rsvps?status=bogus`, { token: host.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/invalid-filter");
    // a valid status filter still works
    expect((await api("GET", `${B}/events/${eventId}/rsvps?status=going`, { token: host.token })).status).toBe(200);
  });
});

describe("event RSVP capacity race (integration)", () => {
  let projectId: string; let B: string;
  let host: { id: string; token: string };
  let u1: { id: string; token: string };
  let u2: { id: string; token: string };
  let eventId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [host, u1, u2] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    eventId = (await api("POST", `${B}/events`, { token: host.token, body: { title: "Race", startTime: "2026-07-01T18:00:00Z", type: "online", capacity: 1 } })).body.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("admits exactly one of two concurrent 'going' RSVPs at capacity 1 (no TOCTOU overshoot)", async () => {
    // Both fire concurrently; the per-event row lock serializes the check+write so the second re-counts
    // under the lock and is rejected. Without the lock, both could read going=0 and both succeed.
    const [r1, r2] = await Promise.all([
      api("POST", `${B}/events/${eventId}/rsvp`, { token: u1.token, body: { status: "going" } }),
      api("POST", `${B}/events/${eventId}/rsvp`, { token: u2.token, body: { status: "going" } }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 400]);
    expect([r1, r2].find((r) => r.status === 400)!.body.code).toBe("events/capacity-full");
    // exactly one seat was taken
    const list = await api("GET", `${B}/events/${eventId}/rsvps`, { token: host.token });
    expect(list.body.data.filter((r: any) => r.status === "going").length).toBe(1);
  });
});

describe("event RSVP/guest-list visibility gate (integration)", () => {
  let projectId: string; let B: string;
  let host: { id: string; token: string };
  let invitee: { id: string; token: string };
  let stranger: { id: string; token: string };
  let eventId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [host, invitee, stranger] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    eventId = (await api("POST", `${B}/events`, { token: host.token, body: { title: "Invite-gated", startTime: "2026-07-01T18:00:00Z", type: "online", visibility: "invite" } })).body.id;
    await api("POST", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: invitee.id } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("anonymous cannot list RSVPs of an invite-only event (403 not-visible)", async () => {
    const res = await api("GET", `${B}/events/${eventId}/rsvps`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("events/not-visible");
  });

  it("a stranger cannot list RSVPs of an invite-only event (403 not-visible)", async () => {
    const res = await api("GET", `${B}/events/${eventId}/rsvps`, { token: stranger.token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("events/not-visible");
  });

  it("a non-invitee cannot RSVP to an invite-only event (403 not-visible)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/rsvp`, { token: stranger.token, body: { status: "going" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("events/not-visible");
  });

  it("a non-invitee cannot DELETE-RSVP an invite-only event (403 not-visible)", async () => {
    const res = await api("DELETE", `${B}/events/${eventId}/rsvp`, { token: stranger.token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("events/not-visible");
  });

  it("a genuine invitee can RSVP and the host can list RSVPs including them", async () => {
    expect((await api("POST", `${B}/events/${eventId}/rsvp`, { token: invitee.token, body: { status: "going" } })).status).toBe(200);
    const list = await api("GET", `${B}/events/${eventId}/rsvps`, { token: host.token });
    expect(list.status).toBe(200);
    expect(list.body.data.some((r: any) => r.userId === invitee.id)).toBe(true);
  });
});
