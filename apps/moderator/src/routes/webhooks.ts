// Inbound webhook receiver — the other side of @agora/api's lib/webhooks.ts. The API is configured
// with this service's URL as the project webhookUrl and subscribed to the content broadcast events
// (entity.created.complete, comment.created.complete, *.updated.complete, message.created.complete).
//
// Broadcasts are fire-and-forget: we verify the signature, ACK 200 immediately, then assess + record
// asynchronously (the API never waits on the LLM). A webhook.test ping just ACKs.
import { Hono } from "hono";
import type { ReportTargetType } from "@agora/contract";
import type { Variables } from "../http/context.js";
import { logger } from "../lib/logger.js";
import { getProjectSecret, verifySignature } from "../lib/webhook-verify.js";
import { assessAndRecord } from "../lib/assess-and-record.js";

interface WebhookEnvelope {
  type: string; // e.g. "entity.created.complete"
  projectId: string;
  stage: "validate" | "complete";
  data: any;
}

// Map an event type to the content kind it concerns. Returns null for non-content events.
function targetTypeOf(type: string): ReportTargetType | null {
  if (type.startsWith("entity.")) return "entity";
  if (type.startsWith("comment.")) return "comment";
  if (type.startsWith("message.")) return "message";
  return null;
}

// Pull the moderatable text out of the shaped object the API broadcasts in `data`.
function extractText(targetType: ReportTargetType, data: any): string {
  if (targetType === "entity") return [data?.title, data?.content].filter(Boolean).join("\n\n").trim();
  return (data?.content ?? "").toString().trim(); // comment / message
}

export const webhookRoutes = new Hono<{ Variables: Variables }>().post("/agora", async (c) => {
  const rawBody = await c.req.text();
  let env: WebhookEnvelope;
  try {
    env = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON", code: "webhook/bad-body" }, 400);
  }

  logger.debug({ type: env.type, projectId: env.projectId, stage: env.stage }, "moderation: webhook received");

  // Connectivity ping (apps/api sendTest) — ACK without a signature requirement.
  if (env.type === "webhook.test") {
    logger.debug({ projectId: env.projectId }, "moderation: webhook test ping");
    return c.json({ ok: true });
  }

  if (!env.projectId) return c.json({ error: "Missing projectId", code: "webhook/no-project" }, 400);

  // Verify the HMAC signature against the per-project secret.
  const secret = await getProjectSecret(env.projectId);
  if (!secret) {
    logger.warn({ projectId: env.projectId, type: env.type }, "moderation: webhook rejected — no signing secret configured");
    return c.json({ error: "No webhook secret configured", code: "webhook/unconfigured" }, 401);
  }
  const ok = verifySignature(secret, c.req.header("x-timestamp") ?? "", rawBody, c.req.header("x-signature") ?? null);
  if (!ok) {
    logger.warn({ projectId: env.projectId, type: env.type }, "moderation: webhook rejected — bad signature");
    return c.json({ error: "Bad signature", code: "webhook/bad-signature" }, 401);
  }

  // We only handle async broadcasts; a validate-stage call (if ever pointed here) just passes.
  if (env.stage !== "complete") return c.json({ valid: true });

  const targetType = targetTypeOf(env.type);
  const targetId = env.data?.id;
  if (targetType && targetId) {
    const text = extractText(targetType, env.data);
    if (text) {
      logger.debug(
        { projectId: env.projectId, type: env.type, targetType, targetId, spaceId: env.data?.spaceId ?? null, textLength: text.length },
        "moderation: dispatching assessment",
      );
      // Fire-and-forget: ACK now, assess in the background. Errors are logged, never surfaced.
      void assessAndRecord({
        projectId: env.projectId,
        targetType,
        targetId,
        spaceId: env.data?.spaceId ?? null,
        text,
      }).catch((err) => logger.error({ err, type: env.type, projectId: env.projectId, targetId }, "moderation: assess failed"));
    } else {
      logger.debug({ projectId: env.projectId, type: env.type, targetType, targetId }, "moderation: skipped — no moderatable text");
    }
  } else {
    logger.debug({ projectId: env.projectId, type: env.type }, "moderation: skipped — non-content event");
  }

  return c.json({ ok: true });
});
