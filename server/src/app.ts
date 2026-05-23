// Builds the Agora Hono app (routes + envelopes + error handling), with NO side effects —
// no server bootstrap, no socket.io. The entrypoint (index.ts) serves it; integration tests
// drive it in-process via app.request().
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Variables } from "./http/context.js";
import { ApiError } from "./http/errors.js";
import { env } from "./lib/env.js";
import { mountRoutes } from "./routes/index.js";

export function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", logger());
  app.use("*", cors({ origin: env.CORS_ORIGIN }));

  app.get("/health", (c) => c.json({ ok: true, service: "agora", version: "v7" }));

  // Replyke contract: everything lives under /v7/:projectId
  app.route("/v7", mountRoutes());

  // Uniform error envelope: { error, code, field? }
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) }, err.status);
    }
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal server error", code: "common/internal" }, 500);
  });

  app.notFound((c) => c.json({ error: "Not found", code: "common/not-found" }, 404));

  return app;
}
