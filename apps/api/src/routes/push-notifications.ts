// apps/api/src/routes/push-notifications.ts
// /v7/:projectId/push-notifications/* — device registration + VAPID public key.
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { pushDevices, pushNotificationPreferences } from "../db/schema/index.js";
import { parseBody } from "../lib/validation.js";
import { pushDeviceSchema, updateNotificationPreferencesSchema, type PushDeviceIdentifier } from "@agora-server/contract";
import { getVapidKeys } from "../lib/push/vapid.js";

// Upsert: native dedupes on (project,user,platform,token); web on (project,user,endpoint).
// Atomic ON CONFLICT ... DO UPDATE avoids the TOCTOU race between concurrent register calls.
async function registerDevice(projectId: string, userId: string, ident: PushDeviceIdentifier): Promise<void> {
  if (ident.platform === "web") {
    // The conflict target references an expression index ((subscription->>'endpoint')), which
    // Drizzle's builder cannot express, so use a raw parameterized statement.
    // All user-supplied values are bound parameters — no string interpolation.
    await getDb().execute(sql`
      INSERT INTO push_devices (project_id, user_id, platform, subscription)
      VALUES (${projectId}::uuid, ${userId}::uuid, 'web', ${JSON.stringify(ident.subscription)}::jsonb)
      ON CONFLICT (project_id, user_id, (subscription->>'endpoint')) WHERE platform = 'web'
      DO UPDATE SET subscription = excluded.subscription, updated_at = now()
    `);
  } else {
    // Conflict target matches push_devices_native_unique partial index exactly.
    await getDb().insert(pushDevices)
      .values({ projectId, userId, platform: ident.platform, token: ident.token })
      .onConflictDoUpdate({
        target: [pushDevices.projectId, pushDevices.userId, pushDevices.platform, pushDevices.token],
        targetWhere: sql`platform IN ('ios','android')`,
        set: { updatedAt: new Date() },
      });
  }
}

async function deregisterDevice(projectId: string, userId: string, ident: PushDeviceIdentifier): Promise<void> {
  if (ident.platform === "web") {
    await getDb().delete(pushDevices).where(and(
      eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId), eq(pushDevices.platform, "web"),
      sql`${pushDevices.subscription}->>'endpoint' = ${ident.subscription.endpoint}`));
  } else {
    await getDb().delete(pushDevices).where(and(
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
  .get("/preferences", requireAuth, async (c) => {
    const [row] = await getDb().select({ disabledTypes: pushNotificationPreferences.disabledTypes })
      .from(pushNotificationPreferences)
      .where(and(eq(pushNotificationPreferences.projectId, c.var.projectId), eq(pushNotificationPreferences.userId, c.var.auth!.userId)))
      .limit(1);
    return c.json({ disabledTypes: row?.disabledTypes ?? [] });
  })
  .put("/preferences", requireAuth, async (c) => {
    const body = parseBody(updateNotificationPreferencesSchema, await c.req.json().catch(() => ({})), "push-notifications");
    const disabledTypes = [...new Set(body.disabledTypes)];
    const [row] = await getDb().insert(pushNotificationPreferences)
      .values({ projectId: c.var.projectId, userId: c.var.auth!.userId, disabledTypes, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [pushNotificationPreferences.projectId, pushNotificationPreferences.userId],
        set: { disabledTypes, updatedAt: new Date() },
      })
      .returning({ disabledTypes: pushNotificationPreferences.disabledTypes });
    return c.json({ disabledTypes: row!.disabledTypes });
  })
  // Intentionally UNAUTHENTICATED (public key, fetched pre-sign-in). Covered by the edge rate-limiter.
  .get("/vapid-public-key", async (c) => {
    const vapid = await getVapidKeys(c.var.projectId);
    return c.json({ publicKey: vapid?.publicKey ?? null });
  });
