// OpenTelemetry bootstrap — MUST be imported FIRST in index.ts (right after dotenv), before
// @hono/node-server / postgres load, so auto-instrumentation can patch http + DB at require time.
// Starts the SDK (traces + metrics + OTLP exporters) from wonder-logger.yaml and registers graceful
// shutdown handlers automatically. Logging is configured separately in lib/logger.ts.
import { createTelemetryFromConfig } from "@jenova-marie/wonder-logger";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve the config relative to THIS module (src → ../ = app root) so it loads under tsx + dist alike.
const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../wonder-logger.yaml");

// Honors otel.enabled in the YAML + the standard OTEL_SDK_DISABLED env var. Shutdown is auto-registered.
export const sdk = createTelemetryFromConfig({ configPath, required: true });
