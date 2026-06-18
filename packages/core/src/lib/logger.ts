// Structured application logger (Pino, via @jenova-marie/wonder-logger). Single shared instance —
// import `logger` everywhere instead of console.*. Config lives in wonder-logger.yaml at the app
// root; OTel/metrics are off in this phase (logging only).
//
// ⚠️ Pino arg order is DATA-OBJECT-FIRST: logger.info({ userId }, "msg"). Passing the message first
//    silently drops the structured data — always `logger.error({ err }, "...")`.
import { createLoggerFromConfig } from "@jenova-marie/wonder-logger";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve the config relative to THIS module (src/lib → ../../ = the @agora/core package root, where
// wonder-logger.yaml is copied), so it loads identically under tsx (src/) and compiled tsc (dist/)
// regardless of process cwd (dev, prod, tests).
const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../wonder-logger.yaml");

// Annotate via ReturnType<…> rather than letting tsc infer `pino.Logger`: core emits declarations, and
// the inferred type would force the .d.ts to name pino's internal (transitive) path (TS2742). Referring
// to createLoggerFromConfig — a direct dependency — keeps the emitted type portable.
export const logger: ReturnType<typeof createLoggerFromConfig> = createLoggerFromConfig({ configPath, required: true });
