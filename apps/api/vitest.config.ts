import { defineConfig } from "vitest/config";

// Unit suite: pure functions, no DB. Integration tests (against TEST_DATABASE_URL,
// a dedicated cloud Supabase test project) get their own config in a later pass.
//
// Importing src modules transitively loads lib/db -> lib/env, which validates env at
// import time and constructs a postgres.js client (lazy — no connection until a query).
// These dummy values satisfy that validation so unit tests never touch a real DB.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/agora_test",
      ACCESS_TOKEN_SECRET: "unit-test-secret-unit-test-secret-unit-test",
      // Hermetic, mirroring vitest.integration.config.ts: a developer's .env may point NEO4J_URI
      // at a live DozerDB; unit tests must never construct a real driver.
      NEO4J_URI: "",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
});
