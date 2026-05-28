// Agora API server entrypoint.
// Mounts /v7/:projectId/* (Replyke-compatible) + a socket.io realtime server.
import "dotenv/config"; // load .env before env.ts validates process.env
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime/socket.js";

const app = createApp();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`🏛️  Agora API listening on http://localhost:${info.port}/v7`);
});

// socket.io shares the underlying Node HTTP server
attachRealtime(server as unknown as import("node:http").Server);
