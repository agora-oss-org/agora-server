// dispatchToUser: load a user's devices, build the per-project provider map, fan out, prune dead rows.
// FCM/APNs providers are wired in Task 8; until then `getProviders` returns them as null (skipped).
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { pushDevices, conversationMembers } from "../../db/schema/index.js";
import type { ProviderMap, PushPayload } from "./provider.js";
import { dispatchToDevices, notificationPushPayload } from "./dispatch.js";
import { getVapidKeys } from "./vapid.js";
import { WebPushProvider } from "./webpush.js";
import { getFcmProvider, getApnsProvider } from "./native.js"; // added in Task 8
import { logger } from "../logger.js";
import { loadDisabledTypes, isTypeDisabled } from "../notification-prefs.js";
import { isConversationMuted } from "../mute.js";

export async function getProviders(projectId: string): Promise<ProviderMap> {
  const vapid = await getVapidKeys(projectId);
  return {
    web: vapid ? new WebPushProvider(vapid) : null,
    ios: await getApnsProvider(projectId),
    android: await getFcmProvider(projectId),
  };
}

export async function dispatchToUser(projectId: string, userId: string, payload: PushPayload): Promise<void> {
  const devices = await getDb().select().from(pushDevices)
    .where(and(eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId)));
  if (devices.length === 0) return;
  const providers = await getProviders(projectId);
  const prune = async (deviceId: string) => { await getDb().delete(pushDevices).where(eq(pushDevices.id, deviceId)); };
  const { sent, pruned } = await dispatchToDevices(devices, payload, providers, prune);
  if (sent || pruned) logger.info(`push: dispatched (sent=${sent} pruned=${pruned})`);
}

/** Fire-and-forget bridge from the notification choke point (never blocks/throws into the request).
 *  No-ops when the type isn't push-worthy (reactions/milestones → in-app only; see allowlist), or
 *  when the user has opted out of this push type (`push_notification_preferences`). */
export function dispatchNotificationPush(projectId: string, userId: string, type: string): void {
  const payload = notificationPushPayload(type);
  if (!payload) return; // suppressed type → in-app only
  (async () => {
    const disabled = await loadDisabledTypes(projectId, userId);
    if (isTypeDisabled(disabled, type)) return; // user opted out of this push type
    await dispatchToUser(projectId, userId, payload);
  })().catch((err) => {
    logger.error("push: notification dispatch failed");
    logger.debug({ err, type }, "push: notification dispatch failed");
  });
}

/** Chat message push: skip when the recipient muted THIS conversation (forever or timed). */
export async function isConversationMutedForUser(projectId: string, conversationId: string, userId: string): Promise<boolean> {
  const [m] = await getDb().select({ mutedUntil: conversationMembers.mutedUntil, mutedForever: conversationMembers.mutedForever })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.projectId, projectId), eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)))
    .limit(1);
  return m ? isConversationMuted(m, new Date()) : false;
}

/** Awaitable chat `message` push: same suppressed-payload + global-opt-out gate as the generic bridge,
 *  plus a per-conversation mute check. Exported so the decision is testable; the request path uses the
 *  fire-and-forget `dispatchChatMessagePush` wrapper below. */
export async function sendChatMessagePush(projectId: string, userId: string, conversationId: string): Promise<void> {
  const payload = notificationPushPayload("message");
  if (!payload) return; // suppressed type → in-app only
  const disabled = await loadDisabledTypes(projectId, userId);
  if (isTypeDisabled(disabled, "message")) return; // global chat-push opt-out (#1)
  if (await isConversationMutedForUser(projectId, conversationId, userId)) return; // per-conversation mute (#2)
  await dispatchToUser(projectId, userId, payload);
}

/** Fire-and-forget bridge for chat `message` push — never blocks/throws into the request. */
export function dispatchChatMessagePush(projectId: string, userId: string, conversationId: string): void {
  sendChatMessagePush(projectId, userId, conversationId).catch((err) => {
    logger.error("push: chat message dispatch failed");
    logger.debug({ err, conversationId }, "push: chat message dispatch failed");
  });
}
