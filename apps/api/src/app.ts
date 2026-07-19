// Builds the Agora Hono app (routes + envelopes + error handling), with NO side effects —
// no server bootstrap, no socket.io. The entrypoint (index.ts) serves it; integration tests
// drive it in-process via app.request().
import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Variables } from "./http/context.js";
import { isDbConnectionError, resolveDbFor, runWithDb } from "./db/index.js";
import { ApiError, Errors } from "./http/errors.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { mountRoutes } from "./routes/index.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { requestLog } from "./middleware/request-log.js";
import { sendDueDigests } from "./lib/digests.js";
import { recomputeDueScores } from "./lib/recompute.js";
import { purgeExpiredRefreshTokens } from "./lib/token-cleanup.js";
import { rollupCommunityStats } from "./lib/community-stats.js";
import { rollupConstellation } from "./lib/social-constellation.js";
import { rollupAnalytics } from "./lib/social-analytics.js";
import { applyClientModeration } from "./lib/client-moderation.js";
import { drainPendingEmbeddings } from "./lib/pending-embeddings.js";
import { hydrateSuspensionIndex } from "@agora/core/lib/suspensions";

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
  // Public-surface CORS preflight fix: hono's cors() short-circuits OPTIONS itself (returns 204
  // without calling next()), so public.ts's post-next Access-Control-Allow-Origin override never
  // runs for a preflight — a browser embedding /public/* content under a non-"*" CORS_ORIGIN would
  // never see a matching ACAO and block the real request. Resolve `*` for the public surface right
  // here in the origin callback (Hono's `(origin, c) => string | null`), before routing.
  // Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md §3 (CORS).
  const PUBLIC_SURFACE = /^\/v7\/[^/]+\/public\//;
  app.use("*", cors({
    origin: (origin, c) => {
      if (PUBLIC_SURFACE.test(c.req.path)) return "*";
      // Preserve the pre-existing CORS_ORIGIN behavior EXACTLY for every other path: hono's
      // string-origin resolver returns "*" unconditionally when configured as "*" (no credentials
      // are ever set here), or an exact match against the configured origin otherwise.
      return env.CORS_ORIGIN === "*" ? "*" : (origin === env.CORS_ORIGIN ? origin : null);
    },
  }));
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
  // Re-materialize the Constellation snapshot (docs/AGORA-SOCIAL.md §12). The in-lib ~6-week epoch gate
  // makes most (weekly) runs a no-op — only projects whose snapshot is stale are recomputed.
  app.post("/internal/cron/social-constellation", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const result = await rollupConstellation();
    logger.info({ result }, "cron: constellation materialized");
    return c.json(result);
  });
  // Re-materialize the operator admin-analytics snapshots (docs/AGORA-CORP.md). The in-lib weekly epoch
  // gate makes most runs a no-op; only projects whose snapshot is stale (per report) are recomputed.
  app.post("/internal/cron/social-analytics", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const result = await rollupAnalytics();
    logger.info({ result }, "cron: admin analytics materialized");
    return c.json(result);
  });

  // Replay pending embeds skipped while the outbound throttle was tripped (lib/pending-embeddings.ts).
  // Deliberately bounded per run (?limit=, default 100) so the backfill paces Voyage; also runs
  // standalone via scripts/drain-embeddings.mjs.
  app.post("/internal/cron/drain-embeddings", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit")) || 100));
    const result = await drainPendingEmbeddings(limit);
    logger.info({ result }, "cron: pending embeddings drained");
    return c.json(result);
  });

  // Reconcile the Redis suspension index against the DB: one atomic rebuild catches new suspensions,
  // lifts, AND endDate expiries (no diffing). No-op when REDIS_URL is unset. Also runs standalone via
  // scripts/sync-suspensions.mjs. The api owns the suspension write endpoints + this reconcile; the
  // shared index is read by @agora/secure-chat too.
  app.post("/internal/cron/sync-suspensions", async (c) => {
    const blocked = cronGuard(c); if (blocked) return blocked;
    const result = await hydrateSuspensionIndex();
    logger.info({ result }, "cron: suspension index reconciled");
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
    const { projectId, targetType, targetId } = body;
    // Seam: the body names the project (no :projectId path segment) — resolve + scope
    // explicitly. A resolver error (unknown project / db unavailable) propagates: fail closed.
    const ok = await runWithDb(await resolveDbFor(projectId), () =>
      applyClientModeration({ projectId, targetType, targetId, status, reason: body.reason }),
    );
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
    // A tenant DB we could not REACH (host down, refused, DNS, connect timeout, dropped socket) is a
    // transient infra outage, not an application bug — map it to a retryable 503, mirroring the
    // resolver's own project/db-unavailable. Query/constraint errors fall through to the 500 below so
    // real defects aren't masked. Log the driver code ONLY: the DSN carries the tenant DB password and
    // must never reach an aggregator-shipped level (Security-first / Log-with-intent).
    if (isDbConnectionError(err)) {
      logger.warn({ code: (err as { code?: string }).code }, "tenant database unreachable");
      logger.debug({ err }, "tenant database unreachable");
      const e = Errors.unavailable("project/db-unavailable", "Project database unavailable");
      return c.json({ error: e.message, code: e.code }, e.status);
    }
    logger.error("unhandled error");
    logger.debug({ err }, "unhandled error");
    return c.json({ error: "Internal server error", code: "common/internal" }, 500);
  });

  app.notFound((c) => c.json({ error: "Not found", code: "common/not-found" }, 404));

  return app;
}
