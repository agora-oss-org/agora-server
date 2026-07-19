// Internet-public entities: the privileged visibility action + (Task 5) the anonymous /public/*
// surface. Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
// Security-first: the negative cases (403/404/400, the no-existence-oracle posture) are the point.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/index.js";
import { entities, comments, spaces, spaceMembers, profiles } from "../../src/db/schema/index.js";
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

  // Fix 1 (final review): the handler loaded the entity excluding only deletedAt — a
  // moderation-removed entity's content leaked through to a non-privileged space admin. This is a
  // read path over moderatable content and must apply the same moderation-visibility gate the
  // walled single-GET uses (lookupEntity's removedPolicy/shouldHide).
  it("404s a space admin PATCHing a moderation-removed entity; 200s an operator on the same entity", async () => {
    const admin = await createUser(projectId);
    const s = await makeSpace("anyone");
    await addMember(s.id, admin.id, "admin");
    const e = await makeEntity({ spaceId: s.id, moderationStatus: "removed" });

    const asAdmin = await vis(e.id, admin.token, false);
    expect(asAdmin.status).toBe(404);
    expect(asAdmin.body.code).toBe("entities/not-found");

    const op = await createUser(projectId);
    const opToken = await signToken(op.id, "visitor", true, false, false, false, projectId);
    const asOperator = await vis(e.id, opToken, false);
    expect(asOperator.status).toBe(200);
  });
});

const anon = (path: string) => api("GET", `${base(projectId)}/public${path}`, {});

describe("GET /public/* — anonymous internet-public reads", () => {
  it("serves a public spaceless entity + its comments + thread, with open CORS", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    const c1 = await makeComment(e.id, author.id, { content: "top" });
    await makeComment(e.id, author.id, { content: "reply", parentId: c1.id });

    const ent = await anon(`/entities/${e.id}`);
    expect(ent.status).toBe(200);
    expect(ent.body.id).toBe(e.id);
    expect(ent.body.public).toBe(true);
    expect(ent.body.userReaction).toBeNull();
    expect(ent.headers.get("access-control-allow-origin")).toBe("*");

    const list = await anon(`/entities/${e.id}/comments`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1); // top-level only
    expect(list.body.data[0].content).toBe("top");
    expect(list.body.data[0].userReaction).toBeNull();
    expect(list.body.pagination).toBeTruthy(); // envelope shape itself is pinned by pagination.test.ts

    const thread = await anon(`/entities/${e.id}/comments/thread`);
    expect(thread.status).toBe(200);
    expect(thread.body.data).toHaveLength(1);
    expect(thread.body.data[0].replies).toHaveLength(1);
    expect(thread.body.data[0].replies[0].content).toBe("reply");
  });

  it("serves a public entity in a public space", async () => {
    const s = await makeSpace("anyone");
    const e = await makeEntity({ spaceId: s.id, isPublic: true });
    expect((await anon(`/entities/${e.id}`)).status).toBe(200);
  });

  it("404s all three routes when the flag is off", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: false, userId: author.id });
    for (const p of [`/entities/${e.id}`, `/entities/${e.id}/comments`, `/entities/${e.id}/comments/thread`]) {
      const res = await anon(p);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("entities/not-found");
    }
  });

  it("404s all three routes when the space has gone members-only (live backstop)", async () => {
    const s = await makeSpace("anyone");
    const e = await makeEntity({ spaceId: s.id, isPublic: true });
    await getDb().update(spaces).set({ readingPermission: "members" }).where(eq(spaces.id, s.id));
    for (const p of [`/entities/${e.id}`, `/entities/${e.id}/comments`, `/entities/${e.id}/comments/thread`])
      expect((await anon(p)).status).toBe(404);
  });

  it("404s a draft, a soft-deleted, and a moderation-removed public entity", async () => {
    for (const e of [
      await makeEntity({ isPublic: true, isDraft: true }),
      await makeEntity({ isPublic: true, deletedAt: new Date() }),
      await makeEntity({ isPublic: true, moderationStatus: "removed" }),
    ]) expect((await anon(`/entities/${e.id}`)).status).toBe(404);
  });

  it("404s malformed and unknown ids (no 500s for probes)", async () => {
    expect((await anon(`/entities/not-a-uuid`)).status).toBe(404);
    expect((await anon(`/entities/${randomUUID()}`)).status).toBe(404);
  });

  it("hides removed comments and deleted comments from the public list and thread", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    await makeComment(e.id, author.id, { content: "visible" });
    await makeComment(e.id, author.id, { content: "removed", moderationStatus: "removed" });
    await makeComment(e.id, author.id, { content: "deleted", deletedAt: new Date() });

    const list = await anon(`/entities/${e.id}/comments`);
    expect(list.body.data.map((x: any) => x.content)).toEqual(["visible"]);
    const thread = await anon(`/entities/${e.id}/comments/thread`);
    expect(thread.body.data.map((x: any) => x.content)).toEqual(["visible"]);
  });

  it("keeps the walled surface walled: anonymous GET /entities/:id is still 401", async () => {
    const e = await makeEntity({ isPublic: true });
    expect((await api("GET", `${base(projectId)}/entities/${e.id}`, {})).status).toBe(401);
    expect((await api("GET", `${base(projectId)}/comments?entityId=${e.id}`, {})).status).toBe(401);
  });

  // Fix 2 (final review): malformed ids reaching raw SQL / a ::uuid cast 500'd instead of 404ing —
  // a real hole on a surface anonymous strangers probe directly.
  it("404s (not 500s) a malformed ?parentId on the comments list", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    const res = await anon(`/entities/${e.id}/comments?parentId=not-a-uuid`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("entities/not-found");
  });

  it("200s (not 500s) a thread request with a garbage 36-hyphen ?rootId, serving the whole thread", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    await makeComment(e.id, author.id, { content: "top" });
    const garbage = "-".repeat(36);
    const res = await anon(`/entities/${e.id}/comments/thread?rootId=${garbage}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].content).toBe("top");
  });

  // Fix 4 (final review): ?include=user handed the full shaped user, incl. birthdate + the
  // free-form profile metadata jsonb, to the anonymous internet. Least-privilege default: redact
  // both on this surface only (the walled surface is untouched).
  it("redacts birthdate + metadata (but keeps username) on ?include=user", async () => {
    const author = await createUser(projectId);
    await getDb().update(profiles)
      .set({ birthdate: "1990-01-01", metadata: { secret: "shh" } })
      .where(eq(profiles.id, author.id));
    const e = await makeEntity({ isPublic: true, userId: author.id });

    const res = await anon(`/entities/${e.id}?include=user`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBeTruthy();
    expect(res.body.user.birthdate).toBeNull();
    expect(res.body.user.metadata).toEqual({});
  });

  // Reviewer-confirmed follow-up: the redaction above was applied only to the entity route — the
  // comment list + thread routes still served the full shaped user (birthdate + metadata) for
  // ?include=user. Same author, same asserts, on the comment surfaces.
  it("redacts birthdate + metadata on the comment list and thread routes too", async () => {
    const author = await createUser(projectId);
    await getDb().update(profiles)
      .set({ birthdate: "1990-01-01", metadata: { secret: "shh" } })
      .where(eq(profiles.id, author.id));
    const e = await makeEntity({ isPublic: true, userId: author.id });
    await makeComment(e.id, author.id, { content: "top" });

    const list = await anon(`/entities/${e.id}/comments?include=user`);
    expect(list.status).toBe(200);
    expect(list.body.data[0].user.username).toBeTruthy();
    expect(list.body.data[0].user.birthdate).toBeNull();
    expect(list.body.data[0].user.metadata).toEqual({});

    const thread = await anon(`/entities/${e.id}/comments/thread?include=user`);
    expect(thread.status).toBe(200);
    expect(thread.body.data[0].user.username).toBeTruthy();
    expect(thread.body.data[0].user.birthdate).toBeNull();
    expect(thread.body.data[0].user.metadata).toEqual({});
  });
});

// Fix 3 (final review): hono's app-wide cors() short-circuits OPTIONS itself (204, no next()), so
// public.ts's post-next Access-Control-Allow-Origin override never ran for a CORS preflight — a
// browser embedding /public/* under a non-"*" CORS_ORIGIN would never see a matching ACAO on the
// preflight and block the real request. app.ts's cors() origin callback must resolve "*" for the
// public surface itself, before routing.
describe("OPTIONS /public/* — CORS preflight (final review Fix 3)", () => {
  it("answers a third-party preflight with Access-Control-Allow-Origin: *", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    const res = await api("OPTIONS", `${base(projectId)}/public/entities/${e.id}`, {
      headers: {
        origin: "https://third-party.example",
        "access-control-request-method": "GET",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

// Shared-cache policy for the anonymous surface (lib/public-cache.ts). The gate is re-derived per
// request precisely so a takedown un-exposes a post; s-maxage is the bounded window in which the
// edge may still serve it, ratified at 300s. max-age=0 keeps every browser reload authoritative.
describe("GET /public/* — cache policy", () => {
  it("makes a 200 shared-cacheable, browser-revalidated, and NOT origin-fragmented", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });

    for (const p of [`/entities/${e.id}`, `/entities/${e.id}/comments`, `/entities/${e.id}/comments/thread`]) {
      const res = await anon(p);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300, must-revalidate");
      expect(res.headers.get("etag")).toBeTruthy();
      // ACAO here is unconditionally "*", so varying by Origin would fragment every shared cache
      // by embedding site for nothing. This is the bug the policy fix removed.
      expect(res.headers.get("vary")).toBeNull();
    }
  });

  it("answers a matching If-None-Match with a bodyless 304 that keeps CORS and freshness usable", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    const first = await anon(`/entities/${e.id}`);
    const tag = first.headers.get("etag")!;
    expect(tag).toBeTruthy();

    const res = await api("GET", `${base(projectId)}/public/entities/${e.id}`, {
      headers: { "if-none-match": tag, origin: "https://third-party.example" },
    });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    // hono's etag() strips every header outside its retained list on a 304. Without the ordering
    // fix (cache/CORS block registered BEFORE etag, so its post-next runs last) a cross-origin
    // embed's revalidation would come back with no ACAO and the browser would block it.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // A 304 revalidates the stored 200 — it must carry that entry's freshness forward, not evict it.
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300, must-revalidate");
    // AGPL §13: the source advert survives the 304 via the explicit retainedHeaders extension.
    expect(res.headers.get("x-source-code")).toBeTruthy();
  });

  it("re-fetches in full when the ETag no longer matches", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    const res = await api("GET", `${base(projectId)}/public/entities/${e.id}`, {
      headers: { "if-none-match": '"stale-etag"' },
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(e.id);
  });

  it("never lets a shared cache hold a gate 404 — publishing would look broken", async () => {
    // The gate 404s a not-yet-published entity. If that 404 were cacheable, flipping public:true
    // would leave the post invisible at the edge for the whole window.
    const e = await makeEntity({ isPublic: false });
    const res = await anon(`/entities/${e.id}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not leak the shared-cache policy onto the walled surface", async () => {
    const author = await createUser(projectId);
    const e = await makeEntity({ isPublic: true, userId: author.id });
    const walled = await api("GET", `${base(projectId)}/entities/${e.id}`, {});
    expect(walled.status).toBe(401); // still walled
    // Error envelopes are globally no-store now (app.ts errorJson), never shared-cacheable.
    expect(walled.headers.get("cache-control")).toBe("no-store");
  });
});
