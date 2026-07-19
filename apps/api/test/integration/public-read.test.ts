// Internet-public entities: the privileged visibility action + (Task 5) the anonymous /public/*
// surface. Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
// Security-first: the negative cases (403/404/400, the no-existence-oracle posture) are the point.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/index.js";
import { entities, comments, spaces, spaceMembers } from "../../src/db/schema/index.js";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";

let projectId: string;

beforeAll(async () => { projectId = await createProject(); });
afterAll(async () => { await deleteProject(projectId); });

async function makeSpace(reading: "anyone" | "members", ownerId?: string) {
  const [s] = await getDb().insert(spaces).values({
    projectId, shortId: randomUUID().slice(0, 10), name: "s",
    readingPermission: reading, userId: ownerId,
  }).returning();
  return s!;
}
async function addMember(spaceId: string, userId: string, role: "member" | "admin" | "moderator" = "member") {
  await getDb().insert(spaceMembers).values({ projectId, spaceId, userId, role, status: "active" });
}
async function makeEntity(opts: {
  spaceId?: string | null; isPublic?: boolean; isDraft?: boolean;
  userId?: string; deletedAt?: Date; moderationStatus?: "removed";
} = {}) {
  const [e] = await getDb().insert(entities).values({
    projectId, shortId: randomUUID().slice(0, 10), content: "hello world",
    spaceId: opts.spaceId ?? null, isPublic: opts.isPublic ?? false,
    isDraft: opts.isDraft ?? false, userId: opts.userId,
    deletedAt: opts.deletedAt, moderationStatus: opts.moderationStatus,
  }).returning();
  return e!;
}
async function makeComment(entityId: string, userId: string, opts: {
  content?: string; moderationStatus?: "removed"; deletedAt?: Date; parentId?: string;
} = {}) {
  const [r] = await getDb().insert(comments).values({
    projectId, entityId, userId, content: opts.content ?? "a comment",
    moderationStatus: opts.moderationStatus, deletedAt: opts.deletedAt,
    userDeletedAt: opts.deletedAt, parentId: opts.parentId,
  }).returning();
  return r!;
}
const vis = (id: string, token: string | undefined, pub: boolean) =>
  api("PATCH", `${base(projectId)}/entities/${id}/visibility`, { token, body: { public: pub } });

describe("PATCH /entities/:id/visibility — authority", () => {
  it("403s an ordinary member and the author; 200s a space admin; 403s a space moderator", async () => {
    const admin = await createUser(projectId);
    const modr = await createUser(projectId);
    const member = await createUser(projectId);
    const author = await createUser(projectId);
    const s = await makeSpace("anyone");
    for (const [u, role] of [[admin, "admin"], [modr, "moderator"], [member, "member"], [author, "member"]] as const)
      await addMember(s.id, u.id, role);
    const e = await makeEntity({ spaceId: s.id, userId: author.id });

    expect((await vis(e.id, member.token, true)).status).toBe(403);
    expect((await vis(e.id, author.token, true)).status).toBe(403);
    expect((await vis(e.id, modr.token, true)).status).toBe(403);
    const ok = await vis(e.id, admin.token, true);
    expect(ok.status).toBe(200);
    expect(ok.body.public).toBe(true);
  });

  it("200s the space owner, a project admin, and an operator", async () => {
    const owner = await createUser(projectId);
    const s = await makeSpace("anyone", owner.id);
    const e = await makeEntity({ spaceId: s.id });
    expect((await vis(e.id, owner.token, true)).status).toBe(200);

    const pa = await createUser(projectId);
    const paToken = await signToken(pa.id, "visitor", false, false, false, true, projectId);
    expect((await vis(e.id, paToken, false)).status).toBe(200);

    const op = await createUser(projectId);
    const opToken = await signToken(op.id, "visitor", true, false, false, false, projectId);
    expect((await vis(e.id, opToken, true)).status).toBe(200);
  });

  it("spaceless entity: project admin 200, ordinary user 403", async () => {
    const e = await makeEntity();
    const u = await createUser(projectId);
    expect((await vis(e.id, u.token, true)).status).toBe(403);
    const pa = await createUser(projectId);
    const paToken = await signToken(pa.id, "visitor", false, false, false, true, projectId);
    expect((await vis(e.id, paToken, true)).status).toBe(200);
  });
});

describe("PATCH /entities/:id/visibility — posture + ladder", () => {
  it("404s (never 403s) a non-member probing a members-only-space entity", async () => {
    const s = await makeSpace("members");
    const e = await makeEntity({ spaceId: s.id });
    const stranger = await createUser(projectId);
    const res = await vis(e.id, stranger.token, true);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("entities/not-found");
  });

  it("404s a nonexistent and a malformed entity id", async () => {
    const u = await createUser(projectId);
    expect((await vis(randomUUID(), u.token, true)).status).toBe(404);
    expect((await api("PATCH", `${base(projectId)}/entities/not-a-uuid/visibility`, { token: u.token, body: { public: true } })).status).toBe(404);
  });

  it("400s the ladder: public:true on a members-only-space entity (even for its admin)", async () => {
    const admin = await createUser(projectId);
    const s = await makeSpace("members");
    await addMember(s.id, admin.id, "admin");
    const e = await makeEntity({ spaceId: s.id });
    const res = await vis(e.id, admin.token, true);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("entities/not-community-public");
  });

  it("always allows public:false (un-publish), even after the space went members-only", async () => {
    const admin = await createUser(projectId);
    const s = await makeSpace("anyone");
    await addMember(s.id, admin.id, "admin");
    const e = await makeEntity({ spaceId: s.id, isPublic: true });
    await getDb().update(spaces).set({ readingPermission: "members" }).where(eq(spaces.id, s.id));
    const res = await vis(e.id, admin.token, false);
    expect(res.status).toBe(200);
    expect(res.body.public).toBe(false);
  });

  it("400s a malformed body", async () => {
    const e = await makeEntity();
    const pa = await createUser(projectId);
    const paToken = await signToken(pa.id, "visitor", false, false, false, true, projectId);
    expect((await api("PATCH", `${base(projectId)}/entities/${e.id}/visibility`, { token: paToken, body: {} })).status).toBe(400);
    expect((await api("PATCH", `${base(projectId)}/entities/${e.id}/visibility`, { token: paToken, body: { public: "yes" } })).status).toBe(400);
  });

  it("401s an anonymous caller (the action stays behind the wall)", async () => {
    const e = await makeEntity({ isPublic: true });
    expect((await vis(e.id, undefined, true)).status).toBe(401);
  });
});
