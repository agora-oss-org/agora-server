// Integration: space `visibility` discovery filtering. Security-negative-first — every "hidden"
// and "404" row is asserted, not just the happy path. Isolated by project_id.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base, signToken } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { spaceMembers } from "../../src/db/schema/index.js";

describe("space visibility — listings & search (integration)", () => {
  let projectId: string, B: string;
  let owner: { id: string; token: string };
  let member: { id: string; token: string }; // active member of the private space
  let stranger: { id: string; token: string }; // no membership
  let adminToken: string;
  let publicId: string, unlistedId: string, privateId: string;

  const createSpace = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token, body: { name: "S", ...body } });

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [owner, member, stranger] = await Promise.all([
      createUser(projectId),
      createUser(projectId),
      createUser(projectId),
    ]);
    adminToken = await signToken((await createUser(projectId)).id, "visitor", false, false, false, true);
    publicId = (await createSpace(owner.token, { visibility: "public", slug: `pub-${projectId.slice(0, 8)}` })).body.id;
    unlistedId = (await createSpace(owner.token, { visibility: "unlisted", slug: `unl-${projectId.slice(0, 8)}` })).body.id;
    privateId = (await createSpace(owner.token, { visibility: "private", slug: `prv-${projectId.slice(0, 8)}` })).body.id;
    // Make `member` an active member of the private space (direct insert — deterministic).
    await getDb().insert(spaceMembers).values({
      projectId, spaceId: privateId, userId: member.id, role: "member", status: "active",
    });
  });

  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  const idsIn = (body: any) => new Set(body.data.map((s: any) => s.id));

  it("GET /spaces: anonymous sees only public", async () => {
    const res = await api("GET", `${B}/spaces?limit=100`);
    const ids = idsIn(res.body);
    expect(ids.has(publicId)).toBe(true);
    expect(ids.has(unlistedId)).toBe(false);
    expect(ids.has(privateId)).toBe(false);
  });

  it("GET /spaces: a stranger sees only public", async () => {
    const ids = idsIn((await api("GET", `${B}/spaces?limit=100`, { token: stranger.token })).body);
    expect(ids.has(publicId)).toBe(true);
    expect(ids.has(unlistedId)).toBe(false);
    expect(ids.has(privateId)).toBe(false);
  });

  it("GET /spaces: the private space's owner and active member see it", async () => {
    expect(idsIn((await api("GET", `${B}/spaces?limit=100`, { token: owner.token })).body).has(privateId)).toBe(true);
    expect(idsIn((await api("GET", `${B}/spaces?limit=100`, { token: member.token })).body).has(privateId)).toBe(true);
  });

  it("GET /spaces: a project-admin sees all three", async () => {
    const ids = idsIn((await api("GET", `${B}/spaces?limit=100`, { token: adminToken })).body);
    expect(ids.has(publicId) && ids.has(unlistedId) && ids.has(privateId)).toBe(true);
  });

  it("POST /search/spaces: a stranger's match excludes unlisted & private", async () => {
    const res = await api("POST", `${B}/search/spaces`, { token: stranger.token, body: { query: "S", limit: 100 } });
    const ids = new Set(res.body.map((r: any) => r.record.id));
    expect(ids.has(publicId)).toBe(true);
    expect(ids.has(unlistedId)).toBe(false);
    expect(ids.has(privateId)).toBe(false);
  });
});

describe("space visibility — children (integration)", () => {
  let projectId: string, B: string;
  let owner: { id: string; token: string };
  let stranger: { id: string; token: string };
  let publicParentId: string, privateChildId: string, privateParentId: string;

  const createSpace = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token, body: { name: "S", ...body } });

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [owner, stranger] = await Promise.all([createUser(projectId), createUser(projectId)]);
    publicParentId = (await createSpace(owner.token, { visibility: "public", slug: `pp-${projectId.slice(0, 8)}` })).body.id;
    privateChildId = (await createSpace(owner.token, { visibility: "private", parentSpaceId: publicParentId, slug: `pc-${projectId.slice(0, 8)}` })).body.id;
    privateParentId = (await createSpace(owner.token, { visibility: "private", slug: `pr-${projectId.slice(0, 8)}` })).body.id;
  });

  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("a private child is absent from a stranger's /children of a public parent", async () => {
    const res = await api("GET", `${B}/spaces/${publicParentId}/children?limit=100`, { token: stranger.token });
    expect(new Set(res.body.data.map((s: any) => s.id)).has(privateChildId)).toBe(false);
  });

  it("a private child is present for the owner", async () => {
    const res = await api("GET", `${B}/spaces/${publicParentId}/children?limit=100`, { token: owner.token });
    expect(new Set(res.body.data.map((s: any) => s.id)).has(privateChildId)).toBe(true);
  });

  it("a stranger hitting /children of a private parent gets 404", async () => {
    const res = await api("GET", `${B}/spaces/${privateParentId}/children`, { token: stranger.token });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("spaces/not-found");
  });
});

describe("space visibility — direct fetch & breadcrumb (integration)", () => {
  let projectId: string, B: string;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let stranger: { id: string; token: string };
  let adminToken: string;
  let publicId: string, unlistedId: string, privateId: string, privateSlug: string;
  let deepChildId: string; // public child under the private parent, for breadcrumb truncation

  const createSpace = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token, body: { name: "S", ...body } });

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [owner, member, stranger] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    adminToken = await signToken((await createUser(projectId)).id, "visitor", false, false, false, true);
    const sfx = projectId.slice(0, 8);
    publicId = (await createSpace(owner.token, { visibility: "public", slug: `pub2-${sfx}` })).body.id;
    unlistedId = (await createSpace(owner.token, { visibility: "unlisted", slug: `unl2-${sfx}` })).body.id;
    privateSlug = `prv2-${sfx}`;
    privateId = (await createSpace(owner.token, { visibility: "private", slug: privateSlug })).body.id;
    // Public child under the private parent → breadcrumb should truncate the private ancestor for a stranger.
    deepChildId = (await createSpace(owner.token, { visibility: "public", parentSpaceId: privateId, slug: `deep-${sfx}` })).body.id;
    await getDb().insert(spaceMembers).values({ projectId, spaceId: privateId, userId: member.id, role: "member", status: "active" });
  });

  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("GET /spaces/:id — public 200 for anyone", async () => {
    expect((await api("GET", `${B}/spaces/${publicId}`)).status).toBe(200);
  });
  it("GET /spaces/:id — unlisted 200 for a stranger (link-shareable)", async () => {
    expect((await api("GET", `${B}/spaces/${unlistedId}`, { token: stranger.token })).status).toBe(200);
  });
  it("GET /spaces/:id — private 404 for a stranger and for anonymous", async () => {
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: stranger.token })).status).toBe(404);
    expect((await api("GET", `${B}/spaces/${privateId}`)).status).toBe(404);
  });
  it("GET /spaces/:id — private 200 for owner, active member, admin", async () => {
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: owner.token })).status).toBe(200);
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: member.token })).status).toBe(200);
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: adminToken })).status).toBe(200);
  });
  it("GET /spaces/by-slug — private 404 for a stranger, 200 for owner", async () => {
    expect((await api("GET", `${B}/spaces/by-slug?slug=${privateSlug}`, { token: stranger.token })).status).toBe(404);
    expect((await api("GET", `${B}/spaces/by-slug?slug=${privateSlug}`, { token: owner.token })).status).toBe(200);
  });
  it("breadcrumb of a public child under a private parent — stranger sees the child only (ancestor truncated)", async () => {
    const res = await api("GET", `${B}/spaces/${deepChildId}/breadcrumb`, { token: stranger.token });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: any) => s.id);
    expect(ids).toEqual([deepChildId]); // private parent truncated
  });
  it("breadcrumb — owner sees the full chain (private parent → child)", async () => {
    const res = await api("GET", `${B}/spaces/${deepChildId}/breadcrumb`, { token: owner.token });
    expect(res.body.data.map((s: any) => s.id)).toEqual([privateId, deepChildId]);
  });
});

describe("space visibility — sub-resources (integration)", () => {
  let projectId: string, B: string;
  let owner: { id: string; token: string };
  let member: { id: string; token: string };
  let stranger: { id: string; token: string };
  let pending: { id: string; token: string }; // applied to the private space, not yet approved
  let privateId: string;

  const createSpace = (token: string, body: Record<string, unknown>) =>
    api("POST", `${B}/spaces`, { token, body: { name: "S", ...body } });

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [owner, member, stranger, pending] = await Promise.all([
      createUser(projectId), createUser(projectId), createUser(projectId), createUser(projectId),
    ]);
    privateId = (await createSpace(owner.token, { visibility: "private", slug: `prv3-${projectId.slice(0, 8)}` })).body.id;
    await getDb().insert(spaceMembers).values({ projectId, spaceId: privateId, userId: member.id, role: "member", status: "active" });
    // `pending` applied but isn't approved yet — may read their OWN row, nothing else.
    await getDb().insert(spaceMembers).values({ projectId, spaceId: privateId, userId: pending.id, role: "member", status: "pending" });
  });

  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  for (const sub of ["members", "team", "rules"]) {
    it(`GET /spaces/:id/${sub} — 404 for a stranger on a private space`, async () => {
      const res = await api("GET", `${B}/spaces/${privateId}/${sub}`, { token: stranger.token });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("spaces/not-found");
    });
    it(`GET /spaces/:id/${sub} — 200 for an active member`, async () => {
      expect((await api("GET", `${B}/spaces/${privateId}/${sub}`, { token: member.token })).status).toBe(200);
    });
  }

  it("GET /spaces/:id/membership/me — 404 for a stranger on a private space", async () => {
    const res = await api("GET", `${B}/spaces/${privateId}/membership/me`, { token: stranger.token });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("spaces/not-found");
  });

  // A pending applicant already knows the space exists (they applied), so they may poll their OWN
  // status — otherwise "apply → can't check status" is a dead end. The exemption is row-scoped only.
  it("GET /spaces/:id/membership/me — a pending applicant reads their OWN row on a private space", async () => {
    const res = await api("GET", `${B}/spaces/${privateId}/membership/me`, { token: pending.token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.isMember).toBe(false); // pending unlocks nothing
  });

  it("the membership/me exemption does NOT unlock any other private-space read for a pending applicant", async () => {
    expect((await api("GET", `${B}/spaces/${privateId}`, { token: pending.token })).status).toBe(404);
    for (const sub of ["members", "team", "rules"]) {
      expect((await api("GET", `${B}/spaces/${privateId}/${sub}`, { token: pending.token })).status).toBe(404);
    }
  });
});
