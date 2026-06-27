// Single source of truth for the wonder-logger.yaml path, resolved module-relative to the @agora/core
// package root (where the YAML is copied — see the `files` field + each app's Dockerfile). Both the
// logger (lib/logger.ts) and each app's OTel bootstrap (src/instrument.ts) load THIS path, so logs,
// traces, and metrics share one config and there's no second YAML to keep in sync.
//
// Resolution is relative to this module (dist/lib → ../../ = the package root), so it loads identically
// under tsx (src/) and compiled tsc (dist/) regardless of process cwd (dev, prod, tests).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const wonderLoggerConfigPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../wonder-logger.yaml");
