// @agora/moderator entrypoint. LLM-backed content moderation: receives the API's signed broadcast
// webhooks, assesses content, auto-acts on high-confidence violations, and serves the admin app's
// review aids.
import "dotenv/config"; // load .env before env.ts validates process.env
import "./instrument.js"; // start OpenTelemetry BEFORE http/db imports below (auto-instrumentation)
import { serve } from "@hono/node-server";
import { env } from "./lib/env.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { moderationEnabled } from "./lib/llm-provider.js";

const app = createApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info(
    { port: info.port, provider: env.MODERATOR_LLM_PROVIDER, llm: moderationEnabled() },
    "🛡️  Agora moderator listening"
  );
});
