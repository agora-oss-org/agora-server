// Re-export shim — the shared logger now lives in the @agora/core kernel (its config,
// wonder-logger.yaml, sits at the core package root). Import sites keep using "../lib/logger.js".
export * from "@agora/core/lib/logger";
