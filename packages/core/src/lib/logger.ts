// Structured application logger (Pino, via @jenova-marie/wonder-logger). Single shared instance —
// import `logger` everywhere instead of console.*. Config lives in wonder-logger.yaml at the app
// root; OTel/metrics are off in this phase (logging only).
//
// ⚠️ Pino arg order is DATA-OBJECT-FIRST: logger.info({ userId }, "msg"). Passing the message first
//    silently drops the structured data — always `logger.error({ err }, "...")`.
import { createLoggerFromConfig } from "@jenova-marie/wonder-logger";
import { wonderLoggerConfigPath as configPath } from "./wonder-logger-config.js";
import { serviceVersion } from "./version.js";

// The config path is shared with each app's OTel bootstrap (src/instrument.ts) via wonder-logger-config.ts
// — one wonder-logger.yaml drives logs, traces, and metrics alike.

// Annotate via ReturnType<…> rather than letting tsc infer `pino.Logger`: core emits declarations, and
// the inferred type would force the .d.ts to name pino's internal (transitive) path (TS2742). Referring
// to createLoggerFromConfig — a direct dependency — keeps the emitted type portable.
// `overrides.version` stamps the RUNNING code version (from package.json) into every log's base
// fields — the YAML no longer carries a version, so nothing goes stale. See lib/version.ts.
export const logger: ReturnType<typeof createLoggerFromConfig> = createLoggerFromConfig({
  configPath,
  required: true,
  overrides: { version: serviceVersion },
});
