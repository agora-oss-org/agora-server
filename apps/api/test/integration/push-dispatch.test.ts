// apps/api/test/integration/push-dispatch.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createProject, createUser, deleteProject } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { pushDevices, projectIntegrations } from "../../src/db/schema/index.js";
import webpush from "web-push";
import { dispatchToUser } from "../../src/lib/push/index.js";

describe("push dispatch — web push (integration)", () => {
  let projectId: string; let user: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    user = await createUser(projectId);
    const keys = webpush.generateVAPIDKeys();
    await db.insert(projectIntegrations).values({ projectId, name: "vapid", data: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:t@x" } });
    await db.insert(pushDevices).values({ projectId, userId: user.id, platform: "web", subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("sends to the user's web device", async () => {
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await dispatchToUser(projectId, user.id, { title: "Hi", body: "There" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("prunes the device on a 410 Gone", async () => {
    const spy = vi.spyOn(webpush, "sendNotification").mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    await dispatchToUser(projectId, user.id, { title: "Hi", body: "There" });
    const rows = await db.select().from(pushDevices).where(eq(pushDevices.userId, user.id));
    expect(rows.length).toBe(0);
    spy.mockRestore();
  });
});
