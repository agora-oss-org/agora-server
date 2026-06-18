// Builds the @agora/secure-chat Hono app — the blind MLS Delivery Service, mounted at
// /v7/:projectId/secure-chat/*. NO side effects (no server bootstrap, no socket.io); index.ts serves it
// and attaches the /secure realtime. Deliberately MINIMAL vs @agora/api's createApp(): no metering
// (secure chat is private by design), no other domain routers — just project resolution + the secure
// routes, which carry their own per-handler requireAuth.
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Variables } from "@agora/core/http/context";
import { ApiError } from "@agora/core/http/errors";
import { env } from "@agora/core/lib/env";
import { logger } from "@agora/core/lib/logger";
import { requestLog } from "@agora/core/middleware/request-log";
import { resolveProject } from "@agora/core/middleware/project";
import { hydrateSuspensionIndex } from "@agora/core/lib/suspensions";
import { suspensionIndexReady } from "@agora/core/lib/suspension-index";
import { secureChatRoutes } from "./routes/secure-chat.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// AGPL-3.0 §13: advertise the corresponding source. Repoint at your fork via AGORA_SOURCE_URL.
const SOURCE_URL =
  (process.env.AGORA_SOURCE_URL || "").trim() || "https://github.com/jenova-marie/agora-server";

export function createSecureApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", requestLog);
  app.use("*", cors({ origin: env.CORS_ORIGIN }));
  app.use("*", async (c, next) => {
    c.header("X-Source-Code", SOURCE_URL);
    await next();
  });

  // Readiness gate: until the Redis suspension index has hydrated, refuse traffic (503). An un-hydrated
  // index would fail OPEN (a suspended user could slip through), so we must not serve before it's ready.
  // index.ts hydrates BEFORE listening, so in practice this only guards the brief boot window / probes.
  app.get("/health", (c) => {
    if (!suspensionIndexReady())
      return c.json({ ok: false, service: "agora-secure-chat", reason: "suspension-index-hydrating" }, 503);
    return c.json({ ok: true, service: "agora-secure-chat", version: "v7", source: SOURCE_URL });
  });
  app.get("/source", (c) => c.redirect(SOURCE_URL, 302));

  // Secret-gated reconcile of the Redis suspension index (atomic rebuild — catches new suspensions,
  // lifts, AND endDate expiries). 503 until CRON_SECRET is set; also runs standalone via
  // scripts/sync-suspensions.mjs. In the v1 co-located deployment @agora/api owns this reconcile too
  // (shared Redis); secure-chat carries its own so it stays self-sufficient.
  const cronGuard = (c: Context<{ Variables: Variables }>) => {
    const secret = env.CRON_SECRET;
    if (!secret) return c.json({ error: "Cron not configured", code: "cron/disabled" }, 503);
    if (!safeEqual(c.req.header("x-cron-secret") ?? "", secret))
      return c.json({ error: "Unauthorized", code: "cron/unauthorized" }, 401);
    return null;
  };
  app.post("/internal/cron/sync-suspensions", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const result = await hydrateSuspensionIndex();
    logger.info({ result }, "cron: suspension index reconciled");
    return c.json(result);
  });

  // Project-scoped: /v7/:projectId/secure-chat/*. Every secure route carries its own requireAuth, so we
  // only resolve the project here — no optionalAuth, no meterUsage (secure chat is private + unmetered).
  const project = new Hono<{ Variables: Variables }>();
  project.use("*", resolveProject);
  project.route("/secure-chat", secureChatRoutes);

  const v7 = new Hono<{ Variables: Variables }>();
  v7.route("/:projectId", project);
  app.route("/v7", v7);

  // Uniform error envelope: { error, code, field? } — identical to @agora/api.
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) }, err.status);
    }
    logger.error("unhandled error");
    logger.debug({ err }, "unhandled error");
    return c.json({ error: "Internal server error", code: "common/internal" }, 500);
  });
  app.notFound((c) => c.json({ error: "Not found", code: "common/not-found" }, 404));

  return app;
}
