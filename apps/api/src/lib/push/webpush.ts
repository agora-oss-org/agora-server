// RFC 8030 + VAPID (RFC 8292) via the `web-push` lib. 404/410 → prune (subscription gone).
import webpush from "web-push";
import type { DeviceLike, PushPayload, PushProvider } from "./provider.js";

export class WebPushProvider implements PushProvider {
  constructor(private vapid: { publicKey: string; privateKey: string; subject: string }) {}
  async send(device: DeviceLike, payload: PushPayload): Promise<{ ok: boolean; prune?: boolean }> {
    const sub = device.subscription as webpush.PushSubscription | null;
    if (!sub) return { ok: false };
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
      });
      return { ok: true };
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      return { ok: false, prune: status === 404 || status === 410 };
    }
  }
}
