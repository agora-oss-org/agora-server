// Agora API server entrypoint.
// Mounts /v7/:projectId/* (Replyke-compatible) + a socket.io realtime server.
import "dotenv/config"; // load .env before env.ts validates process.env
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime/socket.js";
import { logger } from "./lib/logger.js";
import { startMetricsFlush } from "./lib/metrics.js";
import { startRateLimitSweep } from "./lib/rate-limit.js";

const app = createApp();
startMetricsFlush(); // periodic flush of request-metering deltas → api_usage
startRateLimitSweep(); // evict elapsed rate-limit windows so the map stays bounded

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port, url: `http://localhost:${info.port}/v7` }, "🏛️  Agora API listening");
});

// socket.io shares the underlying Node HTTP server
attachRealtime(server as unknown as import("node:http").Server);
