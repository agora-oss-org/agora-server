import { defineConfig } from "vitest/config";

// Unit suite: pure functions + provider adapters with a mocked global fetch. No DB, no real LLM.
// Importing src modules transitively loads lib/env, which validates env at import time; these dummy
// values satisfy that validation. MODERATOR_LLM_API_KEY is set so assess() runs against mocked fetch.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/agora_test",
      ACCESS_TOKEN_SECRET: "unit-test-secret-unit-test-secret-unit-test",
      MODERATOR_LLM_API_KEY: "test-key",
      MODERATOR_LLM_PROVIDER: "openai",
      MODERATOR_LLM_MODEL: "gpt-4o-mini",
    },
  },
});
