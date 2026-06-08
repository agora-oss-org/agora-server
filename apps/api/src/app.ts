// Builds the Agora Hono app (routes + envelopes + error handling), with NO side effects —
// no server bootstrap, no socket.io. The entrypoint (index.ts) serves it; integration tests
// drive it in-process via app.request().
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Variables } from "./http/context.js";
import { ApiError } from "./http/errors.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { mountRoutes } from "./routes/index.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { requestLog } from "./middleware/request-log.js";
import { sendDueDigests } from "./lib/digests.js";
import { recomputeDueScores } from "./lib/recompute.js";
import { purgeExpiredRefreshTokens } from "./lib/token-cleanup.js";
import { rollupCommunityStats } from "./lib/community-stats.js";
import { applyClientModeration } from "./lib/client-moderation.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// AGPL-3.0 §13: users interacting with Agora over a network must be offered its corresponding
// source. We surface it by default; operators running a modified build MUST repoint this at the
// fork they actually run (set AGORA_SOURCE_URL). Empty string is treated as unset.
const SOURCE_URL =
  (process.env.AGORA_SOURCE_URL || "").trim() || "https://github.com/jenova-marie/agora-server";

export function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", requestLog);
  app.use("*", cors({ origin: env.CORS_ORIGIN }));
  // AGPL §13: advertise the corresponding source on every response (cheap header, no body change).
  app.use("*", async (c, next) => {
    c.header("X-Source-Code", SOURCE_URL);
    await next();
  });
  // Edge rate limiting on the public API surface only (health + /internal/cron stay unlimited; cron
  // is secret-gated). No-op unless RATE_LIMIT_MAX / RATE_LIMIT_AUTH_MAX is configured.
  app.use("/v7/*", rateLimit);

  app.get("/health", (c) => c.json({ ok: true, service: "agora", version: "v7", source: SOURCE_URL }));
  // AGPL §13 source offer: a stable, human-reachable link to the running version's source.
  app.get("/source", (c) => c.redirect(SOURCE_URL, 302));

  // Secret-gated cron triggers (external scheduler / Supabase pg_cron + pg_net). Each returns 503
  // until CRON_SECRET is set, 401 on a bad secret; the same work runs standalone via scripts/*.mjs.
  const cronGuard = (c: Context<{ Variables: Variables }>) => {
    const secret = env.CRON_SECRET;
    if (!secret) return c.json({ error: "Cron not configured", code: "cron/disabled" }, 503);
    if (!safeEqual(c.req.header("x-cron-secret") ?? "", secret))
      return c.json({ error: "Unauthorized", code: "cron/unauthorized" }, 401);
    return null;
  };

  // Sweep every digest-enabled space that is due this hour (scripts/send-digests.mjs).
  app.post("/internal/cron/digests", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const result = await sendDueDigests();
    logger.info({ result }, "cron: digests swept");
    return c.json(result);
  });
  // Recompute feed scores: stored-mode `decay` snapshots the half-life value, others re-sync
  // hot_score (scripts/recompute-scores.mjs).
  app.post("/internal/cron/recompute-scores", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const result = await recomputeDueScores();
    logger.info({ result }, "cron: feed scores recomputed");
    return c.json(result);
  });
  // Purge expired refresh tokens so the table doesn't grow unbounded (scripts/purge-tokens.mjs).
  app.post("/internal/cron/purge-tokens", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const result = await purgeExpiredRefreshTokens();
    logger.info({ result }, "cron: expired refresh tokens purged");
    return c.json(result);
  });
  // Roll up the hourly community-activity stats for the operator dashboard, self-healing a trailing
  // window each run (scripts/rollup-community-stats.mjs).
  app.post("/internal/cron/community-stats", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const result = await rollupCommunityStats();
    logger.info({ result }, "cron: community stats rolled up");
    return c.json(result);
  });

  // Automated-moderation write-back: the services/scorer service applies a "client" decision
  // (moderationStatus + moderatedByType="client"). Secret-gated like cron; 503 until configured.
  app.post("/internal/moderation/apply", async (c) => {
    const secret = env.MODERATION_SERVICE_SECRET;
    if (!secret) return c.json({ error: "Moderation service not configured", code: "moderation/disabled" }, 503);
    if (!safeEqual(c.req.header("x-moderation-secret") ?? "", secret))
      return c.json({ error: "Unauthorized", code: "moderation/unauthorized" }, 401);
    const body = (await c.req.json().catch(() => null)) as
      | { projectId?: string; targetType?: string; targetId?: string; status?: string; reason?: string }
      | null;
    if (!body?.projectId || (body.targetType !== "entity" && body.targetType !== "comment") || !body.targetId)
      return c.json({ error: "projectId, targetType (entity|comment) and targetId are required", code: "moderation/bad-request" }, 400);
    const status = body.status === "approved" ? "approved" : "removed";
    const ok = await applyClientModeration({ projectId: body.projectId, targetType: body.targetType, targetId: body.targetId, status, reason: body.reason });
    if (!ok) {
      logger.warn({ projectId: body.projectId, targetType: body.targetType, targetId: body.targetId, status }, "moderation: client write-back target not found");
      return c.json({ error: "Target not found", code: "moderation/not-found" }, 404);
    }
    logger.info({ projectId: body.projectId, targetType: body.targetType, targetId: body.targetId, status }, "moderation: client decision applied");
    return c.json({ success: true });
  });

  // Replyke contract: everything lives under /v7/:projectId
  app.route("/v7", mountRoutes());

  // Uniform error envelope: { error, code, field? }
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
