// Server-side suspension enforcement: a suspended user is blocked on every authed request, operators
// bypass + can lift, lifting restores access, and public reads stay open while suspended.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";

describe("user suspensions", () => {
  let projectId: string;
  let B: string;
  let user: { id: string; token: string };
  let operator: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    user = await createUser(projectId);
    const op = await createUser(projectId);
    operator = { id: op.id, token: await signToken(op.id, "visitor", true) }; // operator claim
  });

  afterAll(async () => {
    await deleteProject(projectId);
  });

  it("blocks a suspended user on authed routes, operator bypasses, lift restores", async () => {
    // baseline: the user can hit an authed route
    expect((await api("GET", `${B}/app-notifications`, { token: user.token })).status).toBe(200);

    // operator suspends the user
    const susp = await api("POST", `${B}/users/${user.id}/suspend`, { token: operator.token, body: { reason: "spam" } });
    expect(susp.status).toBe(201);
    expect(susp.body.endDate).toBeNull();

    // suspended → 403 auth/suspended on an authed route
    const blocked = await api("GET", `${B}/app-notifications`, { token: user.token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("auth/suspended");

    // operator is unaffected
    expect((await api("GET", `${B}/app-notifications`, { token: operator.token })).status).toBe(200);

    // public read (optionalAuth) still works for the suspended user
    expect((await api("GET", `${B}/entities`, { token: user.token })).status).toBe(200);

    // lift → access restored
    const lift = await api("DELETE", `${B}/users/${user.id}/suspend`, { token: operator.token });
    expect(lift.status).toBe(200);
    expect(lift.body.lifted).toBeGreaterThanOrEqual(1);
    expect((await api("GET", `${B}/app-notifications`, { token: user.token })).status).toBe(200);
  });

  it("honors a future endDate and ignores an already-expired one", async () => {
    const other = await createUser(projectId);
    // expired suspension → not enforced
    const past = new Date(Date.now() - 60_000).toISOString();
    expect((await api("POST", `${B}/users/${other.id}/suspend`, { token: operator.token, body: { endDate: past } })).status).toBe(400);
    // future suspension → enforced
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await api("POST", `${B}/users/${other.id}/suspend`, { token: operator.token, body: { endDate: future } })).status).toBe(201);
    expect((await api("GET", `${B}/app-notifications`, { token: other.token })).body.code).toBe("auth/suspended");
  });

  it("suspend endpoints are operator-only", async () => {
    const plain = await createUser(projectId);
    const res = await api("POST", `${B}/users/${user.id}/suspend`, { token: plain.token, body: {} });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("users/operator-only");
  });
});
