// GET /social/constellation gate matrix — hermetic. Unlike weather/neighborhood there is NO infra (503)
// gate: the endpoint reads the seasonally-materialized Postgres snapshot, so a never-materialized project
// returns the asOf:null "forming" payload at 200, not a 503. The clustering math is covered by
// social-constellation-live.test.ts (opt-in, GDS) and the unit suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("social constellation", () => {
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
    const res = await api("GET", `${B}/social/constellation`);
    expect(res.status).toBe(401);
  });

  it("returns the 'forming' payload (200, asOf null) when nothing has been materialized yet", async () => {
    const res = await api("GET", `${B}/social/constellation`, { token: member.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blobs: [], asOf: null, method: null });
  });

  it("400s with social/constellation-disabled when constellationEnabled is off", async () => {
    const patch = await api("PATCH", `${B}/settings/social`, { token: admin.token, body: { constellationEnabled: false } });
    expect(patch.status).toBe(200);
    const res = await api("GET", `${B}/social/constellation`, { token: member.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/constellation-disabled");
  });

  it("graphEnabled=false also disables the constellation, even with constellationEnabled back on", async () => {
    const patch = await api("PATCH", `${B}/settings/social`, {
      token: admin.token, body: { constellationEnabled: null, graphEnabled: false },
    });
    expect(patch.status).toBe(200);
    const res = await api("GET", `${B}/social/constellation`, { token: member.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("social/constellation-disabled");
  });
});
