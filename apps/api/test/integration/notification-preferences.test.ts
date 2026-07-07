// apps/api/test/integration/notification-preferences.test.ts
// Verifies GET default-empty, PUT replace+echo, unknown-type rejection, and auth gating.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("notification preferences (integration)", () => {
  let projectId: string; let B: string; let user: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    user = await createUser(projectId);
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("requires auth on both routes", async () => {
    expect((await api("GET", `${B}/push-notifications/preferences`)).status).toBe(401);
    expect((await api("PUT", `${B}/push-notifications/preferences`, { body: { disabledTypes: [] } })).status).toBe(401);
  });

  it("GET default is { disabledTypes: [] }", async () => {
    const res = await api("GET", `${B}/push-notifications/preferences`, { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disabledTypes: [] });
  });

  it("PUT replaces and echoes the set; GET reflects it", async () => {
    const put = await api("PUT", `${B}/push-notifications/preferences`, {
      token: user.token,
      body: { disabledTypes: ["message", "new-follow"] },
    });
    expect(put.status).toBe(200);
    expect(put.body.disabledTypes.sort()).toEqual(["message", "new-follow"].sort());

    const get = await api("GET", `${B}/push-notifications/preferences`, { token: user.token });
    expect(get.body.disabledTypes.sort()).toEqual(["message", "new-follow"].sort());

    // Full replace, not merge: a second PUT with a smaller set drops the rest.
    const put2 = await api("PUT", `${B}/push-notifications/preferences`, {
      token: user.token,
      body: { disabledTypes: ["message"] },
    });
    expect(put2.status).toBe(200);
    expect(put2.body.disabledTypes).toEqual(["message"]);
  });

  it("rejects an unknown push type with 400", async () => {
    const res = await api("PUT", `${B}/push-notifications/preferences`, {
      token: user.token,
      body: { disabledTypes: ["nope"] },
    });
    expect(res.status).toBe(400);
  });
});
