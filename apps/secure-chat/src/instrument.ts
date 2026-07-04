// OpenTelemetry bootstrap for @agora/secure-chat — MUST be imported FIRST in index.ts (right after
// dotenv), before @hono/node-server / postgres / socket.io load, so auto-instrumentation can patch
// http + DB at require time. Mirrors apps/api/src/instrument.ts; the only difference is the config
// source: secure-chat has no local wonder-logger.yaml, so it loads the SAME @agora/core config the
// shared kernel logger uses (lib/wonder-logger-config.ts) — logs, traces, and metrics stay in lockstep.
//
// Set SERVICE_NAME=agora-secure-chat in this process's env so every signal labels it distinctly from
// agora-api (both share the core YAML, whose service.name defaults to agora-api).
//
// Honors otel.enabled in the YAML + the standard OTEL_SDK_DISABLED env var. Shutdown (SIGTERM/SIGINT
// → sdk.shutdown()) is auto-registered by wonder-logger.
import { createTelemetryFromConfig } from "@jenova-marie/wonder-logger";
import { wonderLoggerConfigPath } from "@agora/core/lib/wonder-logger-config";
import { serviceVersion } from "@agora/core/lib/version";

// Default this process to a distinct service name BEFORE the YAML is read (here and, later in index.ts,
// by the @agora/core logger — imported after this module). The shared core YAML defaults service.name to
// agora-api; without this override secure-chat's traces/metrics/logs would all mis-label as agora-api.
// An explicit SERVICE_NAME in the environment still wins.
if (!process.env.SERVICE_NAME) process.env.SERVICE_NAME = "agora-secure-chat";

// `overrides.serviceVersion` stamps the RUNNING code version into the trace/metric resource (in lockstep
// with the shared core logger's version override); the YAML no longer carries a version.
export const sdk = createTelemetryFromConfig({ configPath: wonderLoggerConfigPath, required: true, overrides: { serviceVersion } });
