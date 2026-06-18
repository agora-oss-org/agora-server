import { defineConfig } from "vitest/config";

// Unit suite: pure functions, no DB (only src/**/*.test.ts — the shapers). The DB-backed integration
// suite has its own config (vitest.integration.config.ts) and is run via `pnpm test:integration`.
//
// Importing src modules can transitively load @agora/core's db -> env, which validates env at import
// time and lazily constructs a postgres.js client (no connection until a query). These dummy values
// satisfy that validation so unit tests never touch a real DB.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/agora_test",
      ACCESS_TOKEN_SECRET: "unit-test-secret-unit-test-secret-unit-test",
    },
  },
});
