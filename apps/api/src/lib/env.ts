// Re-export shim — the validated env schema now lives in the shared @agora/core kernel
// (consumed by both @agora/api and @agora/secure-chat). Import sites keep using "../lib/env.js".
export * from "@agora/core/lib/env";
