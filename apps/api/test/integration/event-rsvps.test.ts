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
});
