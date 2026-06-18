// Agora API server entrypoint.
// Mounts /v7/:projectId/* (Replyke-compatible) + a socket.io realtime server.
import "dotenv/config"; // load .env before env.ts validates process.env
import "./instrument.js"; // start OpenTelemetry BEFORE http/db imports below (auto-instrumentation)
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime/socket.js";
import { logger } from "./lib/logger.js";
import { startMetricsFlush } from "./lib/metrics.js";
import { startRateLimitSweep } from "./lib/rate-limit.js";
import { hydrateSuspensionIndex } from "@agora/core/lib/suspensions";

// Last-resort safety net: a stray rejection/throw from a background task (socket handler, fan-out,
// fire-and-forget index/embeds) must NOT take the whole API down. Node's default is to crash on an
// unhandled rejection — log it (message-only `error` + raw `err` on `debug`, per Log-with-intent)
// and keep serving. Handlers still catch their own errors; this only catches what slips past them.
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection (contained — server stays up)");
  logger.debug({ err: reason }, "unhandled promise rejection (contained — server stays up)");
});
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception (contained — server stays up)");
  logger.debug({ err }, "uncaught exception (contained — server stays up)");
});

const app = createApp();
startMetricsFlush(); // periodic flush of request-metering deltas → api_usage
startRateLimitSweep(); // evict elapsed rate-limit windows so the map stays bounded
// Hydrate the Redis suspension index on boot (no-op without REDIS_URL). Best-effort: a failure is logged
// but doesn't stop the api — with a configured-but-down Redis, authed reads fail closed until it recovers
// and the reconcile cron re-hydrates. The shared index is also read by @agora/secure-chat.
hydrateSuspensionIndex()
  .then((result) => logger.info({ result }, "suspension index hydrated"))
  .catch((err) => {
    logger.error("suspension index hydrate failed at boot");
    logger.debug({ err }, "suspension index hydrate failed at boot");
  });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, url: `http://localhost:${info.port}/v7` }, "🏛️  Agora API listening");
});

// socket.io shares the underlying Node HTTP server
attachRealtime(server as unknown as import("node:http").Server);
