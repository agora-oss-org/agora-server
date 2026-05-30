// Builds the Agora Hono app (routes + envelopes + error handling), with NO side effects —
// no server bootstrap, no socket.io. The entrypoint (index.ts) serves it; integration tests
// drive it in-process via app.request().
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Variables } from "./http/context.js";
import { ApiError } from "./http/errors.js";
import { env } from "./lib/env.js";
import { mountRoutes } from "./routes/index.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { sendDueDigests } from "./lib/digests.js";
import { recomputeDueScores } from "./lib/recompute.js";
import { purgeExpiredRefreshTokens } from "./lib/token-cleanup.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function createApp() {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", logger());
  app.use("*", cors({ origin: env.CORS_ORIGIN }));
  // Edge rate limiting on the public API surface only (health + /internal/cron stay unlimited; cron
  // is secret-gated). No-op unless RATE_LIMIT_MAX / RATE_LIMIT_AUTH_MAX is configured.
  app.use("/v7/*", rateLimit);

  app.get("/health", (c) => c.json({ ok: true, service: "agora", version: "v7" }));

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
  app.post("/internal/cron/digests", async (c) => cronGuard(c) ?? c.json(await sendDueDigests()));
  // Recompute feed scores: stored-mode `decay` snapshots the half-life value, others re-sync
  // hot_score (scripts/recompute-scores.mjs).
  app.post("/internal/cron/recompute-scores", async (c) => cronGuard(c) ?? c.json(await recomputeDueScores()));
  // Purge expired refresh tokens so the table doesn't grow unbounded (scripts/purge-tokens.mjs).
  app.post("/internal/cron/purge-tokens", async (c) => cronGuard(c) ?? c.json(await purgeExpiredRefreshTokens()));

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
