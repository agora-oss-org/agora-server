import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../../src/db/index.js";
import { spaces } from "../../src/db/schema/index.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("events — CRUD + authorization (integration)", () => {
  let projectId: string; let B: string;
  let host: { id: string; token: string };
  let other: { id: string; token: string };
  let eventId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [host, other] = await Promise.all([createUser(projectId), createUser(projectId)]);
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("creates an event (creator auto-added as host)", async () => {
    const res = await api("POST", `${B}/events`, { token: host.token, body: { title: "Launch", startTime: "2026-07-01T18:00:00Z", type: "online" } });
    expect(res.status).toBe(201);
    expect(res.body.hostIds).toEqual([host.id]);
    expect(res.body.rsvpCounts).toEqual({ going: 0, maybe: 0, not_going: 0 });
    eventId = res.body.id;
  });

  it("fetches the event", async () => {
    const res = await api("GET", `${B}/events/${eventId}`, { token: host.token });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Launch");
  });

  it("rejects update by a non-host non-admin (403)", async () => {
    const res = await api("PATCH", `${B}/events/${eventId}`, { token: other.token, body: { title: "hijack" } });
    expect(res.status).toBe(403);
  });

  it("allows a host to update", async () => {
    const res = await api("PATCH", `${B}/events/${eventId}`, { token: host.token, body: { title: "Launch v2" } });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Launch v2");
  });

  it("cancels via the cancel endpoint", async () => {
    const res = await api("POST", `${B}/events/${eventId}/cancel`, { token: host.token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("lists events for the project", async () => {
    const res = await api("GET", `${B}/events`, { token: host.token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((e: any) => e.id === eventId)).toBe(true);
  });

  it("soft-deletes (204) and then 404s on fetch", async () => {
    expect((await api("DELETE", `${B}/events/${eventId}`, { token: host.token })).status).toBe(204);
    expect((await api("GET", `${B}/events/${eventId}`, { token: host.token })).status).toBe(404);
  });

  it("rejects PATCH that moves an event into a members-only space the host can't post in (403)", async () => {
    // `other` owns a members-only space; `host` is not a member, so cannot post there.
    const [space] = await db.insert(spaces).values({
      projectId, shortId: randomUUID().slice(0, 8), name: "Closed", userId: other.id,
      postingPermission: "members",
    }).returning();
    // `host` creates a space-less event they manage…
    const created = await api("POST", `${B}/events`, { token: host.token, body: { title: "Movable", startTime: "2026-08-01T18:00:00Z", type: "online" } });
    expect(created.status).toBe(201);
    // …then tries to reassign it into the restricted space → blocked before any mutation.
    const res = await api("PATCH", `${B}/events/${created.body.id}`, { token: host.token, body: { spaceId: space!.id } });
    expect(res.status).toBe(403);
    // Confirm the spaceId did NOT change despite the rejected PATCH.
    const after = await api("GET", `${B}/events/${created.body.id}`, { token: host.token });
    expect(after.body.spaceId ?? null).toBeNull();
  });
});
