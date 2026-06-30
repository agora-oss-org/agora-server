// Integration: POST /admin/social/constellation/recompute — gate matrix (hermetic).
// The app's NEO4J_URI is empty in the test env, so `neo4jEnabled()` is false. A project-admin
// on a constellation-enabled project passes the config gate but hits the infra gate → 503
// social/graph-unavailable. Disabling the constellation proves the config gate fires BEFORE
// the infra gate (400 even though neo4j is unconfigured). GDS math is covered by
// social-constellation-live.test.ts (opt-in) and the unit suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("admin constellation recompute", () => {
  let projectId: string;
  let adminUser: { id: string; token: string };
  let adminToken: string;
  let memberUser: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    adminUser = await createUser(projectId, "visitor");
    // padmin=true stamps the `padmin` claim; requireProjectAdmin in admin.ts checks that claim.
    adminToken = await signToken(adminUser.id, "visitor", false, false, false, true);
    memberUser = await createUser(projectId, "visitor");
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("requires auth — 401 with no token", async () => {
    const res = await api("POST", `${B}/admin/social/constellation/recompute`);
    expect(res.status).toBe(401);
  });

  it("rejects a plain member with 403", async () => {
    const res = await api("POST", `${B}/admin/social/constellation/recompute`, { token: memberUser.token });
    expect(res.status).toBe(403);
  });

  it("project-admin on an enabled project hits the infra gate → 503 social/graph-unavailable", async () => {
    // Community tier default: graphEnabled=true, constellationEnabled=true. Config gate passes.
    // NEO4J_URI is unset in the integration test env → neo4jEnabled() is false → infra gate fires.
    const res = await api("POST", `${B}/admin/social/constellation/recompute`, { token: adminToken });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("social/graph-unavailable");
  });

  it("constellation-disabled → 400 social/constellation-disabled (config gate fires before infra gate)", async () => {
    // Disable constellation via the settings endpoint (project-admin token satisfies misc.ts's gate).
    const patch = await api("PATCH", `${B}/settings/social`, {
      token: adminToken,
      body: { constellationEnabled: false },
    });
    expect(patch.status).toBe(200);

    // Config gate fires first — returns 400 even though neo4j is also unconfigured.
    const res = await api("POST", `${B}/admin/social/constellation/recompute`, { token: adminToken });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/constellation-disabled");
  });
});
