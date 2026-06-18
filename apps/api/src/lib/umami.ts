// Fire-and-forget Umami analytics — a third, external product-analytics sink alongside `api_usage`
// (per-project request metering) and OTel (ops RED). Reports discrete usage events (signups, posts,
// comments, messages, reactions, follows, searches), NOT per-request metering.
//
// Independent of webhooks.ts on purpose: webhooks are a per-project configured fan-out; Umami is one
// global deployment sink. Mirrors broadcast()'s shape — synchronous, never awaited, never throws.
import { env } from "./env.js";
import { logger } from "./logger.js";

const isConfigured = () => !!(env.AGORA_UMAMI_URL && env.AGORA_UMAMI_SERVER_ID && env.AGORA_UMAMI_SERVER_HOSTNAME);

/**
 * Report a discrete usage event to Umami. No-op unless AGORA_UMAMI_URL + _SERVER_ID + _SERVER_HOSTNAME are all
 * set (so the server runs Umami-free by default). Best-effort: failures are debug-logged, never
 * surfaced — analytics must never disrupt a request. Carry `projectId` in `data` to filter per-tenant.
 */
export function trackEvent(name: string, data?: Record<string, unknown>): void {
  if (!isConfigured()) return;
  void (async () => {
    try {
      // Collect endpoint = AGORA_UMAMI_URL + AGORA_UMAMI_SEND_PATH (default /api/send), joined by
      // concatenation so a path-prefixed base (e.g. https://host/umami) is preserved — `new URL` with
      // an absolute path would drop the prefix. POST { type:"event", payload:{ website, hostname, name,
      // url, data } }. A User-Agent header is REQUIRED — Umami silently drops events without one.
      const base = env.AGORA_UMAMI_URL!.replace(/\/+$/, "");
      const sendPath = env.AGORA_UMAMI_SEND_PATH.startsWith("/") ? env.AGORA_UMAMI_SEND_PATH : `/${env.AGORA_UMAMI_SEND_PATH}`;
      const endpoint = `${base}${sendPath}`;
      logger.trace({ name, data, endpoint, website: env.AGORA_UMAMI_SERVER_ID }, "umami: sending event");
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Agora/1.0",
          ...(env.AGORA_UMAMI_API_KEY ? { "x-umami-api-key": env.AGORA_UMAMI_API_KEY } : {}),
        },
        body: JSON.stringify({
          type: "event",
          payload: {
            website: env.AGORA_UMAMI_SERVER_ID,
            hostname: env.AGORA_UMAMI_SERVER_HOSTNAME,
            name,
            url: `/api/${name}`, // gives a per-event URL breakdown in Umami too
            ...(data ? { data } : {}),
          },
        }),
      });
      if (res.ok) logger.trace({ name, status: res.status }, "umami: event sent");
      else logger.debug({ status: res.status, name }, "umami: send rejected");
    } catch (e) {
      logger.debug({ err: e, name }, "umami: send failed");
    }
  })().catch((err) => logger.debug({ err }, "umami: send failed"));
}
