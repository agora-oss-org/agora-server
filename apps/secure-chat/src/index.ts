// @agora/secure-chat entrypoint — the blind MLS Delivery Service, a SEPARATE deployable from @agora/api.
// Serves /v7/:projectId/secure-chat/* (REST) + the /secure realtime namespace on its OWN engine.io path
// "/secure-socket/" (see realtime/secure-socket.ts for why the path is distinct). Shares the @agora/core
// kernel (db, env, logger, auth) + the same Postgres + Redis as @agora/api.
import "dotenv/config"; // load .env before env.ts validates process.env
import "./instrument.js"; // start OpenTelemetry BEFORE http/db/socket.io imports below (auto-instrumentation)
import { serve } from "@hono/node-server";
import { env } from "@agora/core/lib/env";
import { logger } from "@agora/core/lib/logger";
import { hydrateSuspensionIndex } from "@agora/core/lib/suspensions";
import { createSecureApp } from "./app.js";
import { attachSecureRealtime } from "./realtime/secure-socket.js";

// Last-resort safety net: a stray rejection/throw from a background task (socket handler, fan-out) must
// NOT take the service down. Node's default is to crash on an unhandled rejection — log it (message-only
// `error` + raw `err` on `debug`, per Log-with-intent) and keep serving (mirrors @agora/api/index.ts).
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection (contained — secure-chat stays up)");
  logger.debug({ err: reason }, "unhandled promise rejection (contained — secure-chat stays up)");
});
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception (contained — secure-chat stays up)");
  logger.debug({ err }, "uncaught exception (contained — secure-chat stays up)");
});

// Hydrate the Redis suspension index BEFORE listening — the readiness gate. secure-chat treats Redis as
// a HARD dependency, so a boot hydrate failure means refuse to start (the orchestrator restarts; compose
// `depends_on: redis (healthy)` ensures Redis is up first). An un-hydrated index must never serve — it
// would fail OPEN. With REDIS_URL unset this is a no-op that marks ready (falls back to the DB read).
try {
  const result = await hydrateSuspensionIndex();
  logger.info({ result }, "suspension index hydrated");
} catch (err) {
  logger.error("suspension index hydrate failed at boot — refusing to start");
  logger.debug({ err }, "suspension index hydrate failed at boot — refusing to start");
  process.exit(1);
}

const app = createSecureApp();

const server = serve({ fetch: app.fetch, port: env.SECURE_CHAT_PORT }, (info) => {
  logger.info({ port: info.port, url: `http://localhost:${info.port}/v7` }, "🔒 Agora secure-chat listening");
});

// The /secure realtime owns its OWN socket.io server on this same Node HTTP server, on engine.io
// path "/secure-socket/" (distinct from @agora/api's default "/socket.io/").
attachSecureRealtime(server as unknown as import("node:http").Server);
