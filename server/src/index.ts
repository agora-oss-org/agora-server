// Agora API server entrypoint.
// Mounts /v7/:projectId/* (Replyke-compatible) + a socket.io realtime server.
import "dotenv/config"; // load .env before env.ts validates process.env
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Variables } from "./http/context.js";
import { ApiError } from "./http/errors.js";
import { env } from "./lib/env.js";
import { mountRoutes } from "./routes/index.js";
import { attachRealtime } from "./realtime/socket.js";

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

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`🏛️  Agora API listening on http://localhost:${info.port}/v7`);
});

// socket.io shares the underlying Node HTTP server
attachRealtime(server as unknown as import("node:http").Server);
