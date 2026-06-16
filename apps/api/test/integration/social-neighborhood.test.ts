// GET /social/neighborhood gate matrix — hermetic (vitest.integration.config.ts forces NEO4J_URI empty,
// so the infra gate deterministically 503s). Order under test: auth → config (400) → infra (503).
// The real-graph math is covered by social-neighborhood-live.test.ts (opt-in) and the unit suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("social neighborhood", () => {
  let projectId: string;
  let admin: { id: string; token: string };
  let member: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    admin = await createUser(projectId, "admin");
    member = await createUser(projectId, "visitor");
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("requires auth", async () => {
    const res = await api("GET", `${B}/social/neighborhood`);
    expect(res.status).toBe(401);
  });

  it("503s with social/graph-unavailable when Neo4j is unconfigured (default config: enabled)", async () => {
    const res = await api("GET", `${B}/social/neighborhood`, { token: member.token });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("social/graph-unavailable");
  });

  it("400s with social/neighborhood-disabled when neighborhoodEnabled is off — config gate beats infra", async () => {
    const patch = await api("PATCH", `${B}/settings/social`, { token: admin.token, body: { neighborhoodEnabled: false } });
    expect(patch.status).toBe(200);
    const res = await api("GET", `${B}/social/neighborhood`, { token: member.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/neighborhood-disabled");
  });

  it("graphEnabled=false also disables the neighborhood, even with neighborhoodEnabled back on", async () => {
    const patch = await api("PATCH", `${B}/settings/social`, {
      token: admin.token, body: { neighborhoodEnabled: null, graphEnabled: false },
    });
    expect(patch.status).toBe(200);
    const res = await api("GET", `${B}/social/neighborhood`, { token: member.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/neighborhood-disabled");
  });
});
