// Re-export shim — the Drizzle client (`db`) + schema namespace now live in the @agora/core kernel,
// so @agora/api and @agora/secure-chat share one postgres.js connection definition. Import sites keep
// using "../db/index.js".
export * from "@agora/core/db";
