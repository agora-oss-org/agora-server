// GET /social/weather gate matrix — hermetic (vitest.integration.config.ts forces NEO4J_URI empty,
// so the infra gate deterministically 503s). Order under test: auth → config (400) → infra (503).
// The real-graph math is covered by social-weather-live.test.ts (opt-in) and the unit suite.
// NOTE: the last three tests are sequential-state (each PATCH builds on the previous one), matching
// the social-config.test.ts convention — don't .skip or reorder them individually.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("social weather", () => {
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
    const res = await api("GET", `${B}/social/weather`);
    expect(res.status).toBe(401);
  });

  it("503s with social/graph-unavailable when Neo4j is unconfigured (default config: enabled)", async () => {
    const res = await api("GET", `${B}/social/weather`, { token: member.token });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("social/graph-unavailable");
  });

  it("400s with social/weather-disabled when weatherEnabled is off — config gate beats infra gate", async () => {
    const patch = await api("PATCH", `${B}/settings/social`, { token: admin.token, body: { weatherEnabled: false } });
    expect(patch.status).toBe(200);
    const res = await api("GET", `${B}/social/weather`, { token: member.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/weather-disabled");
  });

  it("graphEnabled=false also disables weather, even with weatherEnabled back on", async () => {
    const patch = await api("PATCH", `${B}/settings/social`, {
      token: admin.token, body: { weatherEnabled: null, graphEnabled: false },
    });
    expect(patch.status).toBe(200);
    const res = await api("GET", `${B}/social/weather`, { token: member.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/weather-disabled");
  });

  it("transparency endpoint still serves at its original path after moving to routes/social.ts", async () => {
    const res = await api("GET", `${B}/social/transparency`, { token: member.token });
    expect(res.status).toBe(200);
    expect(res.body.garden.weather).toBe(true); // weatherEnabled override was cleared above
    expect(res.body.garden.graph).toBe(false);  // graphEnabled=false from the previous test
  });
});
