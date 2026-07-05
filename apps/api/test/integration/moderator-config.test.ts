import { describe, it, expect, afterAll } from "vitest";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("scorer moderator_config — gray-zone + co-participates overrides", () => {
  const created: string[] = [];
  afterAll(async () => { for (const p of created) await deleteProject(p); });

  async function adminCtx() {
    const projectId = await createProject();
    created.push(projectId);
    const u = await createUser(projectId, "visitor");
    const token = await signToken(u.id, "visitor", false, false, false, true /* project admin */);
    return { projectId, token };
  }

  it("persists and round-trips the new fields", async () => {
    const { projectId, token } = await adminCtx();
    const patch = await api("PATCH", `${base(projectId)}/settings/moderator`, {
      token,
      body: { grayzoneLow: 0.2, grayzoneHigh: 0.7, coParticipatesMaxParticipants: 120 },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.grayzoneLow).toBe(0.2);
    expect(patch.body.grayzoneHigh).toBe(0.7);
    expect(patch.body.coParticipatesMaxParticipants).toBe(120);

    const get = await api("GET", `${base(projectId)}/settings/moderator`, { token });
    expect(get.body.grayzoneHigh).toBe(0.7);
  });

  it("clearing a field (null) reverts it to unset in the view", async () => {
    const { projectId, token } = await adminCtx();
    await api("PATCH", `${base(projectId)}/settings/moderator`, { token, body: { grayzoneLow: 0.4 } });
    const cleared = await api("PATCH", `${base(projectId)}/settings/moderator`, { token, body: { grayzoneLow: null } });
    expect(cleared.body.grayzoneLow).toBeNull();
  });

  it("rejects an inverted gray-zone band in one PATCH", async () => {
    const { projectId, token } = await adminCtx();
    const res = await api("PATCH", `${base(projectId)}/settings/moderator`, {
      token, body: { grayzoneLow: 0.9, grayzoneHigh: 0.2 },
    });
    expect(res.status).toBe(400); // caught by the contract superRefine
  });

  it("rejects an inverted band assembled across two PATCHes (resulting-state guard)", async () => {
    const { projectId, token } = await adminCtx();
    await api("PATCH", `${base(projectId)}/settings/moderator`, { token, body: { grayzoneHigh: 0.3 } });
    const res = await api("PATCH", `${base(projectId)}/settings/moderator`, { token, body: { grayzoneLow: 0.8 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("moderator/grayzone-order");
  });
});
