// Pure dispatch orchestration: route each device to its provider, collect results, prune dead rows.
// DB-free + provider-agnostic so it's hermetically unit-testable (the real getProviders()/pruneDevice
// are injected by dispatchToUser in lib/push/index.ts).
import type { DeviceLike, PushPayload, PushProvider, ProviderMap } from "./provider.js";
import { logger } from "../logger.js";

export function pickProvider(platform: string, providers: ProviderMap): PushProvider | null {
  return platform === "ios" || platform === "android" || platform === "web" ? providers[platform] : null;
}

export async function dispatchToDevices(
  devices: DeviceLike[],
  payload: PushPayload,
  providers: ProviderMap,
  prune: (deviceId: string) => Promise<void>,
): Promise<{ sent: number; pruned: number }> {
  let sent = 0, pruned = 0;
  await Promise.all(devices.map(async (d) => {
    const provider = pickProvider(d.platform, providers);
    if (!provider) return; // transport not configured → skip silently
    try {
      const res = await provider.send(d, payload);
      if (res.ok) sent++;
      if (res.prune) { await prune(d.id); pruned++; }
    } catch (err) {
      logger.error("push: provider send failed");
      logger.debug({ err, platform: d.platform }, "push: provider send failed");
    }
  }));
  return { sent, pruned };
}

// Allowlist + PII-free push copy, keyed by the in-app notification `type`. ONE place owns both the
// gate and the copy: the allowlist IS the keys of this map — a type not present returns null and the
// bridge no-ops. A push must never carry another user's identity/PII (SECURITY.md); deep-link via data.type.
//
// SILENT (in-app only, deliberately absent from the map):
//  - reactions + reaction-milestones (entity/comment -upvote, -reaction, -reaction-milestone-*) — noise.
//  - ALL steward events (steward-case-*, steward-content-removed, steward-mediation-invite) — conflict
//    resolution is sensitive; a lock-screen push must never reveal a case exists / content was removed.
const PUSH_TITLES: Record<string, string> = {
  "entity-comment": "New comment",
  "comment-reply": "New reply",
  "comment-mention": "You were mentioned",
  "entity-mention": "You were mentioned",
  "new-follow": "New follower",
  "connection-request": "New connection request",
  "connection-accepted": "Connection accepted",
  "space-membership-approved": "Membership approved",
};

export function notificationPushPayload(type: string): PushPayload | null {
  const title = PUSH_TITLES[type];
  if (!title) return null; // not push-worthy → in-app only
  return { title, body: "Open the app to see what's new.", data: { type } };
}
