// dispatchToUser: load a user's devices, build the per-project provider map, fan out, prune dead rows.
// FCM/APNs providers are wired in Task 8; until then `getProviders` returns them as null (skipped).
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { pushDevices } from "../../db/schema/index.js";
import type { ProviderMap, PushPayload } from "./provider.js";
import { dispatchToDevices, notificationPushPayload } from "./dispatch.js";
import { getVapidKeys } from "./vapid.js";
import { WebPushProvider } from "./webpush.js";
import { getFcmProvider, getApnsProvider } from "./native.js"; // added in Task 8
import { logger } from "../logger.js";

export async function getProviders(projectId: string): Promise<ProviderMap> {
  const vapid = await getVapidKeys(projectId);
  return {
    web: vapid ? new WebPushProvider(vapid) : null,
    ios: await getApnsProvider(projectId),
    android: await getFcmProvider(projectId),
  };
}

export async function dispatchToUser(projectId: string, userId: string, payload: PushPayload): Promise<void> {
  const devices = await db.select().from(pushDevices)
    .where(and(eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId)));
  if (devices.length === 0) return;
  const providers = await getProviders(projectId);
  const prune = async (deviceId: string) => { await db.delete(pushDevices).where(eq(pushDevices.id, deviceId)); };
  const { sent, pruned } = await dispatchToDevices(devices, payload, providers, prune);
  if (sent || pruned) logger.info(`push: dispatched (sent=${sent} pruned=${pruned})`);
}

/** Fire-and-forget bridge from the notification choke point (never blocks/throws into the request).
 *  No-ops when the type isn't push-worthy (reactions/milestones → in-app only; see allowlist). */
export function dispatchNotificationPush(projectId: string, userId: string, type: string): void {
  const payload = notificationPushPayload(type);
  if (!payload) return; // suppressed type → in-app only
  dispatchToUser(projectId, userId, payload).catch((err) => {
    logger.error("push: notification dispatch failed");
    logger.debug({ err, type }, "push: notification dispatch failed");
  });
}
