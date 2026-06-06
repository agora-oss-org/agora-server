// Integration: the project-admin webhook config surface (GET/PATCH /webhooks/config + /webhooks/test).
// Admin-gated; the secret is never returned (only hasSecret). The test-ping makes one outbound
// request to a dead local port (fast connection-refused) — no live receiver needed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("webhook config surface (integration)", () => {
  let projectId: string;
  let admin: { id: string; token: string };
  let visitor: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    admin = await createUser(projectId, "admin");
    visitor = await createUser(projectId); // visitor role
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("requires project-admin role", async () => {
    expect((await api("GET", `${B}/webhooks/config`, { token: visitor.token })).status).toBe(403);
    const denied = await api("PATCH", `${B}/webhooks/config`, { token: visitor.token, body: { url: "https://x/h" } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("project/not-admin"); // shared requireProjectAdmin guard (misc.ts)
    expect((await api("GET", `${B}/webhooks/config`)).status).toBe(401); // unauthenticated
  });

  it("starts empty, then PATCH sets config (secret never returned)", async () => {
    const empty = await api("GET", `${B}/webhooks/config`, { token: admin.token });
    expect(empty.body).toEqual({ url: null, events: [], hasSecret: false });

    const set = await api("PATCH", `${B}/webhooks/config`, {
      token: admin.token,
      body: { url: "https://hooks.example.com/agora", secret: "whsec_supersecret", events: ["entity.created", "entity.created.complete"] },
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ url: "https://hooks.example.com/agora", events: ["entity.created", "entity.created.complete"], hasSecret: true });
    expect("secret" in set.body).toBe(false);

    const got = await api("GET", `${B}/webhooks/config`, { token: admin.token });
    expect(got.body).toMatchObject({ url: "https://hooks.example.com/agora", hasSecret: true });
    expect(got.body.events).toEqual(["entity.created", "entity.created.complete"]);
  });

  it("test-ping reports delivery result against the configured URL", async () => {
    // point at a dead local port → fast connection refused
    await api("PATCH", `${B}/webhooks/config`, { token: admin.token, body: { url: "http://127.0.0.1:9/hook" } });
    const ping = await api("POST", `${B}/webhooks/test`, { token: admin.token });
    expect(ping.status).toBe(200);
    expect(ping.body.configured).toBe(true);
    expect(ping.body.ok).toBe(false); // unreachable
  });

  it("clearing the URL → test-ping 400 not-configured", async () => {
    await api("PATCH", `${B}/webhooks/config`, { token: admin.token, body: { url: null } });
    expect((await api("GET", `${B}/webhooks/config`, { token: admin.token })).body.url).toBeNull();
    const ping = await api("POST", `${B}/webhooks/test`, { token: admin.token });
    expect(ping.status).toBe(400);
    expect(ping.body.code).toBe("webhooks/not-configured");
  });
});
