// Integration: reports — create (auth-gated, validated) + the moderated list, including the
// full create → resolve-in-space → appears-in-/moderated loop.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("reports (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let reporter: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    [owner, reporter] = await Promise.all([createUser(projectId), createUser(projectId)]);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("creates a report (authed, validated)", async () => {
    const { body: entity } = await api("POST", `${B}/entities`, { token: owner.token, body: { title: "bad" } });
    const res = await api("POST", `${B}/reports`, {
      token: reporter.token,
      body: { targetType: "entity", targetId: entity.id, reason: "spam" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ targetType: "entity", targetId: entity.id, reason: "spam" });
  });

  it("requires auth to report", async () => {
    const res = await api("POST", `${B}/reports`, { body: { targetType: "entity", targetId: owner.id, reason: "x" } });
    expect(res.status).toBe(401);
  });

  it("validates the body", async () => {
    const res = await api("POST", `${B}/reports`, { token: reporter.token, body: { reason: "missing target" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("reports/invalid-body");
  });

  it("a report shows in /moderated only after it's resolved in its space", async () => {
    const { body: space } = await api("POST", `${B}/spaces`, { token: owner.token, body: { name: "Mod Space" } });
    const { body: entity } = await api("POST", `${B}/entities`, {
      token: owner.token,
      body: { title: "in space", spaceId: space.id },
    });
    const { body: report } = await api("POST", `${B}/reports`, {
      token: reporter.token,
      body: { targetType: "entity", targetId: entity.id, reason: "spam", spaceId: space.id },
    });

    // unresolved → absent from /moderated
    const before = await api("GET", `${B}/reports/moderated`, { token: owner.token });
    expect(before.body.data.map((r: any) => r.id)).not.toContain(report.id);

    // resolve via the space's moderation endpoint (admin-gated)
    const resolve = await api("PATCH", `${B}/spaces/${space.id}/reports/entity/${entity.id}`, { token: owner.token });
    expect(resolve.status).toBe(200);

    const after = await api("GET", `${B}/reports/moderated`, { token: owner.token });
    expect(after.body.data.map((r: any) => r.id)).toContain(report.id);
  });
});
