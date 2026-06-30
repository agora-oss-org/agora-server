// apps/api/src/routes/push-notifications.ts
// /v7/:projectId/push-notifications/* — device registration + VAPID public key.
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { pushDevices } from "../db/schema/index.js";
import { parseBody } from "../lib/validation.js";
import { pushDeviceSchema, type PushDeviceIdentifier } from "@agora-server/contract";
import { getVapidKeys } from "../lib/push/vapid.js";

// Upsert: native dedupes on (project,user,platform,token); web on (project,user,endpoint).
async function registerDevice(projectId: string, userId: string, ident: PushDeviceIdentifier): Promise<void> {
  if (ident.platform === "web") {
    const endpoint = ident.subscription.endpoint;
    const updated = await db.update(pushDevices).set({ subscription: ident.subscription, updatedAt: new Date() })
      .where(and(eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId), eq(pushDevices.platform, "web"), sql`${pushDevices.subscription}->>'endpoint' = ${endpoint}`)).returning({ id: pushDevices.id });
    if (updated.length === 0) {
      await db.insert(pushDevices).values({ projectId, userId, platform: "web", subscription: ident.subscription });
    }
  } else {
    const updated = await db.update(pushDevices).set({ updatedAt: new Date() })
      .where(and(eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId), eq(pushDevices.platform, ident.platform), eq(pushDevices.token, ident.token))).returning({ id: pushDevices.id });
    if (updated.length === 0) {
      await db.insert(pushDevices).values({ projectId, userId, platform: ident.platform, token: ident.token });
    }
  }
}

async function deregisterDevice(projectId: string, userId: string, ident: PushDeviceIdentifier): Promise<void> {
  if (ident.platform === "web") {
    await db.delete(pushDevices).where(and(
      eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId), eq(pushDevices.platform, "web"),
      sql`${pushDevices.subscription}->>'endpoint' = ${ident.subscription.endpoint}`));
  } else {
    await db.delete(pushDevices).where(and(
      eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId),
      eq(pushDevices.platform, ident.platform), eq(pushDevices.token, ident.token)));
  }
}

export const pushNotificationRoutes = new Hono<{ Variables: Variables }>()
  .post("/devices", requireAuth, async (c) => {
    const ident = parseBody(pushDeviceSchema, await c.req.json().catch(() => ({})), "push-notifications");
    await registerDevice(c.var.projectId, c.var.auth!.userId, ident);
    return c.body(null, 204);
  })
  .delete("/devices", requireAuth, async (c) => {
    const ident = parseBody(pushDeviceSchema, await c.req.json().catch(() => ({})), "push-notifications");
    await deregisterDevice(c.var.projectId, c.var.auth!.userId, ident);
    return c.body(null, 204);
  })
  // Proxy-safe fallback for gateways that strip DELETE bodies.
  .post("/devices/deregister", requireAuth, async (c) => {
    const ident = parseBody(pushDeviceSchema, await c.req.json().catch(() => ({})), "push-notifications");
    await deregisterDevice(c.var.projectId, c.var.auth!.userId, ident);
    return c.body(null, 204);
  })
  // Intentionally UNAUTHENTICATED (public key, fetched pre-sign-in). Covered by the edge rate-limiter.
  .get("/vapid-public-key", async (c) => {
    const vapid = await getVapidKeys(c.var.projectId);
    return c.json({ publicKey: vapid?.publicKey ?? null });
  });
