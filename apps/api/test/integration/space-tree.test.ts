// Integration: resolveSpaceSubtree — recursive CTE over spaces.parent_space_id. Builds a real
// root → child → grandchild tree via POST /spaces (mirrors spaces-depth.test.ts's mkSpace pattern)
// since there is no seedSpaceTree helper, then asserts self+descendants, leaf, and project scoping.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { resolveSpaceSubtree } from "../../src/lib/space-tree.js";

describe("resolveSpaceSubtree (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let B: string;
  let root: string;
  let child: string;
  let grandchild: string;

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    B = base(projectId);

    const mkSpace = (body: Record<string, unknown>) =>
      api("POST", `${B}/spaces`, { token: owner.token, body: { name: "S", ...body } });

    const r = (await mkSpace({ name: "Root" })).body;
    const c = (await mkSpace({ name: "Child", parentSpaceId: r.id })).body;
    const g = (await mkSpace({ name: "Grandchild", parentSpaceId: c.id })).body;
    root = r.id;
    child = c.id;
    grandchild = g.id;
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("returns self + all descendants for the root", async () => {
    const ids = (await resolveSpaceSubtree(projectId, root)).sort();
    expect(ids).toEqual([root, child, grandchild].sort());
  });

  it("a leaf returns just itself", async () => {
    expect(await resolveSpaceSubtree(projectId, grandchild)).toEqual([grandchild]);
  });

  it("never crosses project boundaries", async () => {
    const otherProjectId = await createProject();
    try {
      // Same space id looked up under a different project must yield nothing (project_id-scoped).
      expect(await resolveSpaceSubtree(otherProjectId, root)).toEqual([]);
    } finally {
      await deleteProject(otherProjectId);
    }
  });
});
