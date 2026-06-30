// apps/api/test/integration/push-devices.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { pushDevices, projectIntegrations } from "../../src/db/schema/index.js";
import { eq } from "drizzle-orm";
import webpush from "web-push";

describe("push devices (integration)", () => {
  let projectId: string; let B: string; let user: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    user = await createUser(projectId);
    const keys = webpush.generateVAPIDKeys();
    await db.insert(projectIntegrations).values({ projectId, name: "vapid", data: { publicKey: keys.publicKey, privateKey: keys.privateKey } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("requires auth to register", async () => {
    expect((await api("POST", `${B}/push-notifications/devices`, { body: { platform: "ios", token: "t1" } })).status).toBe(401);
  });

  it("registers a native device (idempotent upsert)", async () => {
    expect((await api("POST", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "ios", token: "t1" } })).status).toBe(204);
    expect((await api("POST", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "ios", token: "t1" } })).status).toBe(204); // idempotent
    const rows = await db.select().from(pushDevices).where(eq(pushDevices.userId, user.id));
    expect(rows.filter((r) => r.platform === "ios" && r.token === "t1").length).toBe(1);
  });

  it("deregisters (idempotent — 204 even when unknown)", async () => {
    expect((await api("DELETE", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "ios", token: "t1" } })).status).toBe(204);
    expect((await api("DELETE", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "ios", token: "nope" } })).status).toBe(204);
    const rows = await db.select().from(pushDevices).where(eq(pushDevices.userId, user.id));
    expect(rows.length).toBe(0);
  });

  it("the POST /deregister fallback also removes", async () => {
    await api("POST", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "android", token: "a1" } });
    expect((await api("POST", `${B}/push-notifications/devices/deregister`, { token: user.token, body: { platform: "android", token: "a1" } })).status).toBe(204);
  });

  it("serves the VAPID public key unauthenticated", async () => {
    const res = await api("GET", `${B}/push-notifications/vapid-public-key`);
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe("string");
  });
});
