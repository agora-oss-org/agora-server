import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/index.js";
import { spaces, events, files } from "../../src/db/schema/index.js";
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
    const [space] = await getDb().insert(spaces).values({
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

  it("hides a public event living in a members-reading space from non-members; shows it to the space owner/host", async () => {
    // `host` owns a members-reading (private) space, and creates a *public*-visibility event in it.
    // GET /:eventId already 403s a non-member via assertCanReadSpace; the list must match (fail closed).
    const [space] = await getDb().insert(spaces).values({
      projectId, shortId: randomUUID().slice(0, 8), name: "Members-read", userId: host.id,
      readingPermission: "members", postingPermission: "anyone",
    }).returning();
    const created = await api("POST", `${B}/events`, { token: host.token, body: { title: "Hidden public", startTime: "2026-09-01T18:00:00Z", type: "online", spaceId: space!.id } });
    expect(created.status).toBe(201);
    const evId = created.body.id;
    // Non-member (authed `other`): event must NOT appear in the list.
    const strangerList = await api("GET", `${B}/events`, { token: other.token });
    expect(strangerList.body.data.some((e: any) => e.id === evId)).toBe(false);
    // And the single-GET already 403s the non-member — list/single stay consistent.
    expect((await api("GET", `${B}/events/${evId}`, { token: other.token })).status).toBe(403);
    // Space owner/host: event still appears.
    const ownerList = await api("GET", `${B}/events`, { token: host.token });
    expect(ownerList.body.data.some((e: any) => e.id === evId)).toBe(true);
  });

  it("rejects an unknown enum filter with a clean 400 (not a Postgres 500)", async () => {
    expect((await api("GET", `${B}/events?type=bogus`, { token: host.token })).status).toBe(400);
    expect((await api("GET", `${B}/events?status=nonsense`, { token: host.token })).status).toBe(400);
    // valid enum filters still work
    expect((await api("GET", `${B}/events?status=active`, { token: host.token })).status).toBe(200);
  });

  it("hides an invite-only event in a members-reading space from a non-member invitee (list ↔ single-GET consistent)", async () => {
    // host owns a members-reading space and creates an *invite*-visibility event in it, then invites
    // `other` — who is NOT a member of the space. single-GET 403s `other` via the space-read gate even
    // though invited; the list must agree (previously the invite branch leaked it).
    const [space] = await getDb().insert(spaces).values({
      projectId, shortId: `sp_${Date.now().toString(36)}`, name: "Members-read invite", userId: host.id,
      readingPermission: "members", postingPermission: "anyone",
    }).returning();
    const created = await api("POST", `${B}/events`, { token: host.token, body: { title: "Invite in private space", startTime: "2026-10-01T18:00:00Z", type: "online", visibility: "invite", spaceId: space!.id } });
    expect(created.status).toBe(201);
    const evId = created.body.id;
    expect((await api("POST", `${B}/events/${evId}/invites`, { token: host.token, body: { userId: other.id } })).status).toBe(200);
    // single-GET 403s the non-member invitee…
    expect((await api("GET", `${B}/events/${evId}`, { token: other.token })).status).toBe(403);
    // …so the list must hide it too.
    const list = await api("GET", `${B}/events`, { token: other.token });
    expect(list.body.data.some((e: any) => e.id === evId)).toBe(false);
  });

  it("hides an event whose space was soft-deleted from single-GET too (list ↔ single-GET consistent, fail closed)", async () => {
    // A public event in a public space. Once the space is soft-deleted, the list already drops the
    // event (spaceReadable requires `deleted_at is null`); single-GET must agree instead of leaking it.
    const [space] = await getDb().insert(spaces).values({
      projectId, shortId: `sp_${Date.now().toString(36)}`, name: "Doomed", userId: host.id,
      readingPermission: "anyone", postingPermission: "anyone",
    }).returning();
    const created = await api("POST", `${B}/events`, { token: host.token, body: { title: "Orphaned", startTime: "2026-12-01T18:00:00Z", type: "online", spaceId: space!.id } });
    expect(created.status).toBe(201);
    const evId = created.body.id;
    expect((await api("GET", `${B}/events/${evId}`, { token: host.token })).status).toBe(200); // visible while the space is live
    await getDb().update(spaces).set({ deletedAt: new Date() }).where(eq(spaces.id, space!.id));
    // List hides it (existing behavior)…
    const list = await api("GET", `${B}/events`, { token: host.token });
    expect(list.body.data.some((e: any) => e.id === evId)).toBe(false);
    // …and single-GET must now 404 too (previously it leaked the orphaned event). Fail closed.
    expect((await api("GET", `${B}/events/${evId}`, { token: host.token })).status).toBe(404);
  });

  it("clears coverImageId when the cover file is removed via removeImageIds", async () => {
    const created = await api("POST", `${B}/events`, { token: host.token, body: { title: "Has cover", startTime: "2026-11-01T18:00:00Z", type: "online" } });
    const evId = created.body.id;
    // Simulate a stored cover (bypassing the upload pipeline): a files row + the event's cover pointer.
    const [file] = await getDb().insert(files).values({
      projectId, eventId: evId, type: "image", originalPath: "test/cover.webp",
    }).returning();
    await getDb().update(events).set({ coverImageId: file!.id }).where(eq(events.id, evId));
    expect((await api("GET", `${B}/events/${evId}`, { token: host.token })).body.coverImageId).toBe(file!.id);
    // Removing the cover file must null the pointer (no dangling coverImageId).
    const patched = await api("PATCH", `${B}/events/${evId}`, { token: host.token, body: { removeImageIds: [file!.id] } });
    expect(patched.status).toBe(200);
    expect(patched.body.coverImageId ?? null).toBeNull();
  });
});
