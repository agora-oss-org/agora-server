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
