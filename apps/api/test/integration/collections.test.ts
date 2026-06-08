// Integration: collections — user-owned saved-entity folders. Exercises the entity_count
// trigger, the is-entity-saved lookup (on the entities route), nesting, and ownership scoping.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { collectionEntities } from "../../src/db/schema/index.js";

describe("collections (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let other: { id: string; token: string };
  let entityId: string;
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    [owner, other] = await Promise.all([createUser(projectId), createUser(projectId)]);
    B = base(projectId);
    const e = await api("POST", `${B}/entities`, { token: owner.token, body: { title: "savable" } });
    entityId = e.body.id;
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  const createCollection = (token: string, body: Record<string, unknown> = {}) =>
    api("POST", `${B}/collections`, { token, body: { name: "Faves", ...body } });
  // is-entity-saved spans ALL of the user's collections, so assertions about it use a fresh
  // entity to avoid leakage from other tests that saved the shared `entityId`.
  const isSaved = (token: string, eid: string) =>
    api("GET", `${B}/entities/is-entity-saved?entityId=${eid}`, { token });
  const freshEntity = async () =>
    (await api("POST", `${B}/entities`, { token: owner.token, body: { title: "e" } })).body.id as string;

  it("creates a collection (entityCount 0, owned, shows in root list)", async () => {
    const res = await createCollection(owner.token);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Faves", userId: owner.id, entityCount: 0, parentId: null });

    const root = await api("GET", `${B}/collections/root`, { token: owner.token });
    expect(root.body.data.map((c: any) => c.id)).toContain(res.body.id);
  });

  it("adding an entity bumps entity_count (trigger) and flips is-entity-saved", async () => {
    const { body: col } = await createCollection(owner.token);
    const eid = await freshEntity();

    expect((await isSaved(owner.token, eid)).body.isSaved).toBe(false);

    const add = await api("POST", `${B}/collections/${col.id}/entities`, { token: owner.token, body: { entityId: eid } });
    expect(add.status).toBe(201);

    const fetched = await api("GET", `${B}/collections/${col.id}`, { token: owner.token });
    expect(fetched.body.entityCount).toBe(1); // maintained by on_collection_entity_change trigger

    expect((await isSaved(owner.token, eid)).body.isSaved).toBe(true);

    const list = await api("GET", `${B}/collections/${col.id}/entities`, { token: owner.token });
    expect(list.body.data.map((e: any) => e.id)).toContain(eid);
    expect(list.body.pagination.totalItems).toBe(1);
  });

  it("re-adding the same entity is idempotent (count stays 1)", async () => {
    const { body: col } = await createCollection(owner.token);
    await api("POST", `${B}/collections/${col.id}/entities`, { token: owner.token, body: { entityId } });
    await api("POST", `${B}/collections/${col.id}/entities`, { token: owner.token, body: { entityId } });
    const fetched = await api("GET", `${B}/collections/${col.id}`, { token: owner.token });
    expect(fetched.body.entityCount).toBe(1);
  });

  it("removing an entity decrements the count and clears is-entity-saved", async () => {
    const { body: col } = await createCollection(owner.token);
    const eid = await freshEntity();
    await api("POST", `${B}/collections/${col.id}/entities`, { token: owner.token, body: { entityId: eid } });

    const del = await api("DELETE", `${B}/collections/${col.id}/entities/${eid}`, { token: owner.token });
    expect(del.status).toBe(200);

    const fetched = await api("GET", `${B}/collections/${col.id}`, { token: owner.token });
    expect(fetched.body.entityCount).toBe(0);
    expect((await isSaved(owner.token, eid)).body.isSaved).toBe(false);
  });

  it("nests sub-collections (listed under parent, excluded from root)", async () => {
    const { body: parent } = await createCollection(owner.token, { name: "Parent" });
    const sub = await api("POST", `${B}/collections/${parent.id}/sub-collections`, {
      token: owner.token,
      body: { name: "Child" },
    });
    expect(sub.status).toBe(201);
    expect(sub.body.parentId).toBe(parent.id);

    const subs = await api("GET", `${B}/collections/${parent.id}/sub-collections`, { token: owner.token });
    expect(subs.body.data.map((c: any) => c.id)).toContain(sub.body.id);

    const root = await api("GET", `${B}/collections/root`, { token: owner.token });
    expect(root.body.data.map((c: any) => c.id)).not.toContain(sub.body.id); // child isn't a root
  });

  it("scopes to the owner (another user gets 403)", async () => {
    const { body: col } = await createCollection(owner.token);

    const read = await api("GET", `${B}/collections/${col.id}`, { token: other.token });
    expect(read.status).toBe(403);
    expect(read.body.code).toBe("collections/not-owner");

    const add = await api("POST", `${B}/collections/${col.id}/entities`, { token: other.token, body: { entityId } });
    expect(add.status).toBe(403);
  });
});

// Security regression: a collection in project A must never be able to reference an entity from
// project B. The handler rejects a foreign entityId with 404, and the DB trigger
// (0034_collection_entity_same_project) is the last-line backstop if a handler check is ever missed.
describe("collections cross-tenant isolation (security)", () => {
  let projectA: string;
  let projectB: string;
  let A: string;
  let owner: { id: string; token: string };
  let collectionId: string;
  let foreignEntityId: string; // an entity that lives in project B
  let nativeEntityId: string; // an entity that lives in project A

  beforeAll(async () => {
    [projectA, projectB] = await Promise.all([createProject(), createProject()]);
    A = base(projectA);
    owner = await createUser(projectA);
    const ownerB = await createUser(projectB);

    const col = await api("POST", `${A}/collections`, { token: owner.token, body: { name: "A-faves" } });
    collectionId = col.body.id;
    nativeEntityId = (await api("POST", `${A}/entities`, { token: owner.token, body: { title: "native" } })).body.id;
    // Created in project B by a project-B user — must be invisible/untouchable from project A.
    foreignEntityId = (await api("POST", `${base(projectB)}/entities`, { token: ownerB.token, body: { title: "foreign" } })).body.id;
  });

  afterAll(async () => {
    await Promise.all([deleteProject(projectA), deleteProject(projectB)].map((p) => p.catch(() => {})));
  });

  it("POST /:id/entities rejects a foreign-project entity with 404 (no cross-tenant link)", async () => {
    const add = await api("POST", `${A}/collections/${collectionId}/entities`, { token: owner.token, body: { entityId: foreignEntityId } });
    expect(add.status).toBe(404);
    expect(add.body.code).toBe("entity/not-found");

    // and nothing was linked
    const list = await api("GET", `${A}/collections/${collectionId}/entities`, { token: owner.token });
    expect(list.body.data.map((e: any) => e.id)).not.toContain(foreignEntityId);
    expect(list.body.pagination.totalItems).toBe(0);
  });

  it("DELETE /:id/entities/:entityId rejects a foreign-project entity with 404", async () => {
    const del = await api("DELETE", `${A}/collections/${collectionId}/entities/${foreignEntityId}`, { token: owner.token });
    expect(del.status).toBe(404);
    expect(del.body.code).toBe("entity/not-found");
  });

  it("DB trigger blocks a cross-project collection_entities row even bypassing the handler", async () => {
    // Direct insert (no handler) — the BEFORE INSERT trigger must raise on the project_id mismatch.
    await expect(
      db.insert(collectionEntities).values({ collectionId, entityId: foreignEntityId }),
    ).rejects.toThrow();
  });

  it("a same-project entity still links normally (no false positives)", async () => {
    const add = await api("POST", `${A}/collections/${collectionId}/entities`, { token: owner.token, body: { entityId: nativeEntityId } });
    expect(add.status).toBe(201);
    const list = await api("GET", `${A}/collections/${collectionId}/entities`, { token: owner.token });
    expect(list.body.data.map((e: any) => e.id)).toContain(nativeEntityId);
    expect(list.body.pagination.totalItems).toBe(1);
  });
});
