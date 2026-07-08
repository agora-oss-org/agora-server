// apps/api/test/integration/match-users.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("POST /match/users (stub)", () => {
  let projectId: string;
  let B: string;
  let alice: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    alice = await createUser(projectId);
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("passive mode → { results: [] }", async () => {
    const res = await api("POST", `${B}/match/users`, { token: alice.token, body: { mode: "passive" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it("directed without a query → 400", async () => {
    const res = await api("POST", `${B}/match/users`, { token: alice.token, body: { mode: "directed" } });
    expect(res.status).toBe(400);
  });

  it("directed with a query → 200 { results: [] }", async () => {
    const res = await api("POST", `${B}/match/users`, { token: alice.token, body: { mode: "directed", query: "art" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it("unauthenticated → 401", async () => {
    const res = await api("POST", `${B}/match/users`, { body: { mode: "passive" } });
    expect(res.status).toBe(401);
  });
});
