// Builds the Agora Hono app (routes + envelopes + error handling), with NO side effects —
// no server bootstrap, no socket.io. The entrypoint (index.ts) serves it; integration tests
// drive it in-process via app.request().
import crypto from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Variables } from "./http/context.js";
import { ApiError } from "./http/errors.js";
import { env } from "./lib/env.js";
import { mountRoutes } from "./routes/index.js";
import { sendDueDigests } from "./lib/digests.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", logger());
  app.use("*", cors({ origin: env.CORS_ORIGIN }));

  app.get("/health", (c) => c.json({ ok: true, service: "agora", version: "v7" }));

  // Secret-gated cron trigger for space digests (external scheduler / Supabase pg_cron + pg_net).
  // Not project-scoped; sweeps every digest-enabled space that is due this hour. Disabled (503)
  // until CRON_SECRET is set. The same work is also runnable standalone via scripts/send-digests.mjs.
  app.post("/internal/cron/digests", async (c) => {
    const secret = env.CRON_SECRET;
    if (!secret) return c.json({ error: "Cron not configured", code: "cron/disabled" }, 503);
    const provided = c.req.header("x-cron-secret") ?? "";
    if (!safeEqual(provided, secret)) return c.json({ error: "Unauthorized", code: "cron/unauthorized" }, 401);
    return c.json(await sendDueDigests());
  });

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
