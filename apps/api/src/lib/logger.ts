// Structured application logger (Pino, via @jenova-marie/wonder-logger). Single shared instance —
// import `logger` everywhere instead of console.*. Config lives in wonder-logger.yaml at the app
// root; OTel/metrics are off in this phase (logging only).
//
// ⚠️ Pino arg order is DATA-OBJECT-FIRST: logger.info({ userId }, "msg"). Passing the message first
//    silently drops the structured data — always `logger.error({ err }, "...")`.
import { createLoggerFromConfig } from "@jenova-marie/wonder-logger";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve the config relative to THIS module (src/lib → ../../ = app root), so it loads identically
// under tsx (src/) and compiled tsc (dist/) regardless of process cwd (dev, prod, tests).
const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../wonder-logger.yaml");

export const logger = createLoggerFromConfig({ configPath, required: true });
