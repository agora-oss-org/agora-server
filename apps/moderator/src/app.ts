// Builds the moderator Hono app (routes + error handling), with NO side effects — no server
// bootstrap. The entrypoint (index.ts) serves it; tests can drive it in-process via app.request().
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Variables } from "./http/context.js";
import { ApiError } from "./http/errors.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { moderationEnabled } from "./lib/llm-provider.js";
import { requestLog } from "./middleware/request-log.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { moderationRoutes } from "./routes/moderation.js";

export function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", requestLog);
  app.use("*", cors({ origin: env.CORS_ORIGIN }));

  app.get("/health", (c) =>
    c.json({ ok: true, service: "agora-moderator", llm: moderationEnabled() ? env.MODERATOR_LLM_PROVIDER : null })
  );

  // Inbound webhook receiver (the API's signed broadcast events land here).
  app.route("/webhooks", webhookRoutes);
  // Admin-facing review aids, operator-gated. The moderator is its own service (not the Replyke /v7
  // contract surface), so it carries its own API version: /v1/:projectId/moderation/*
  app.route("/v1/:projectId/moderation", moderationRoutes);

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) }, err.status);
    }
    logger.error({ err }, "unhandled error");
    return c.json({ error: "Internal server error", code: "common/internal" }, 500);
  });

  app.notFound((c) => c.json({ error: "Not found", code: "common/not-found" }, 404));

  return app;
}
