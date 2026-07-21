// Integration: event visibility inside semantic search (migration 0066).
//
// Search is an ENUMERATION surface, so its gate must never be more permissive than GET /events.
// Both now call the same can_view_event() SQL function; these tests assert the negative cases —
// the non-invitee, the non-member, the anonymous caller, the invitee who can't read the space —
// plus a direct search ⊆ list parity check, which is the invariant the shared function exists for.
//
// Embeddings are inserted directly with synthetic vectors so this is deterministic without a Voyage
// key (same approach as semantic-search.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { contentEmbeddings, events, spaces } from "../../src/db/schema/index.js";

const DIMS = 1024;
const vec = (...head: number[]) => { const a = new Array(DIMS).fill(0); head.forEach((x, i) => (a[i] = x)); return a; };
const lit = (a: number[]) => `[${a.join(",")}]`;

describe("event visibility in match_content (integration)", () => {
  let projectId: string, B: string;
  let host: { id: string; token: string };
  let invitee: { id: string; token: string };
  let member: { id: string; token: string };
  let stranger: { id: string; token: string };
  const ev = {} as Record<string, string>;
  let privateSpaceId: string;

  /** Event ids returned by match_content for a given viewer (non-privileged unless stated). */
  const searchIds = async (viewer: string | null, privileged = false) => {
    const rows = (await getDb().execute(sql`
      select source_id from match_content(
        ${projectId}::uuid, ${lit(vec(1))}::vector, 50, array['event']::text[], null::uuid,
        ${viewer}::uuid, ${privileged}, ${!privileged}, null::uuid[])
    `)) as unknown as { source_id: string }[];
    return new Set([...rows].map((r) => r.source_id));
  };

  const mkEvent = async (token: string, body: Record<string, unknown>) => {
    const res = await api("POST", `${B}/events`, {
      token, body: { startTime: "2026-09-01T18:00:00Z", type: "online", ...body },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    host = await createUser(projectId);
    invitee = await createUser(projectId);
    member = await createUser(projectId);
    stranger = await createUser(projectId);

    // A members-reading (private) space owned by `host`, with `member` as an active member.
    const [sp] = await getDb().insert(spaces).values({
      projectId, shortId: randomUUID().slice(0, 8), name: "Private", userId: host.id,
      readingPermission: "members", postingPermission: "anyone",
    }).returning();
    privateSpaceId = sp!.id;
    await api("POST", `${B}/spaces/${privateSpaceId}/join`, { token: member.token });

    ev.public = await mkEvent(host.token, { title: "Public ramen night", visibility: "public" });
    ev.members = await mkEvent(host.token, { title: "Members ramen night", visibility: "members" });
    ev.invite = await mkEvent(host.token, { title: "Invite ramen night", visibility: "invite" });
    // An invite-only event inside the PRIVATE space: the invitee is invited but cannot read the
    // space. The space gate is AND'd across the whole predicate, so this must stay hidden.
    ev.inviteInPrivate = await mkEvent(host.token, {
      title: "Invite ramen in private space", visibility: "invite", spaceId: privateSpaceId,
    });
    ev.removed = await mkEvent(host.token, { title: "Removed ramen night", visibility: "public" });
    ev.deleted = await mkEvent(host.token, { title: "Deleted ramen night", visibility: "public" });

    for (const id of [ev.invite, ev.inviteInPrivate]) {
      const res = await api("POST", `${B}/events/${id}/invites`, { token: host.token, body: { userId: invitee.id } });
      expect(res.status).toBe(200);
    }
    await getDb().update(events).set({ moderationStatus: "removed" }).where(eq(events.id, ev.removed));
    await getDb().update(events).set({ deletedAt: new Date() }).where(eq(events.id, ev.deleted));

    // Deterministic synthetic vectors — every event is a perfect match for the query, so anything
    // filtered out was filtered by the VISIBILITY gate and nothing else.
    await getDb().delete(contentEmbeddings).where(eq(contentEmbeddings.projectId, projectId));
    await getDb().insert(contentEmbeddings).values(
      Object.values(ev).map((sourceId) => ({ projectId, sourceType: "event" as const, sourceId, embedding: vec(1) })),
    );
  });

  afterAll(async () => { await deleteProject(projectId); });

  it("shows only public events to an anonymous caller", async () => {
    const ids = await searchIds(null);
    expect(ids.has(ev.public)).toBe(true);
    expect(ids.has(ev.members)).toBe(false);
    expect(ids.has(ev.invite)).toBe(false);
    expect(ids.has(ev.inviteInPrivate)).toBe(false);
  });

  it("hides a members-only event from anonymous but shows it to any authed user", async () => {
    expect((await searchIds(null)).has(ev.members)).toBe(false);
    expect((await searchIds(stranger.id)).has(ev.members)).toBe(true);
  });

  it("hides an invite-only event from a non-invitee, shows it to the invitee and the host", async () => {
    expect((await searchIds(stranger.id)).has(ev.invite)).toBe(false);
    expect((await searchIds(invitee.id)).has(ev.invite)).toBe(true);
    expect((await searchIds(host.id)).has(ev.invite)).toBe(true);
  });

  it("hides an event in a private space from a non-member EVEN IF they are invited", async () => {
    // The leak this guards: invite grants event access, but not space access. If the space gate were
    // OR'd into the visibility branches instead of AND'd across them, this would return the event —
    // and search would be more permissive than GET /events/:id, which 403s.
    expect((await searchIds(invitee.id)).has(ev.inviteInPrivate)).toBe(false);
    expect((await api("GET", `${B}/events/${ev.inviteInPrivate}`, { token: invitee.token })).status).toBe(403);
    // The space owner (also the host) still sees it.
    expect((await searchIds(host.id)).has(ev.inviteInPrivate)).toBe(true);
  });

  it("hides moderation-removed events from members but surfaces them to a privileged caller", async () => {
    expect((await searchIds(stranger.id)).has(ev.removed)).toBe(false);
    expect((await searchIds(null)).has(ev.removed)).toBe(false);
    expect((await searchIds(host.id, true)).has(ev.removed)).toBe(true);
  });

  it("never returns a soft-deleted event, even to a privileged caller", async () => {
    expect((await searchIds(host.id, true)).has(ev.deleted)).toBe(false);
    expect((await searchIds(stranger.id)).has(ev.deleted)).toBe(false);
  });

  it("keeps search results a SUBSET of what GET /events lists, for every caller", async () => {
    // The invariant can_view_event() exists to guarantee. If these two ever drift, search has become
    // an enumeration hole — this is the test that catches it.
    for (const who of [stranger, invitee, member, host]) {
      const listed = new Set<string>(
        (await api("GET", `${B}/events?limit=100`, { token: who.token })).body.data.map((e: any) => e.id),
      );
      for (const id of await searchIds(who.id)) {
        expect(listed.has(id), `event ${id} is searchable but not listable for user ${who.id}`).toBe(true);
      }
    }
  });
});
