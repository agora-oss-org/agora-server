// Re-export shim — the Drizzle schema (single source of truth for all tables) now lives in the
// @agora/core kernel. Import sites keep using "../db/schema/index.js".
export * from "@agora/core/db/schema";
