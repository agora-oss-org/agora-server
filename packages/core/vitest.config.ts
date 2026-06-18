import { defineConfig } from "vitest/config";

// Unit suite for the shared kernel: pure functions, no real DB/Redis. Importing kernel modules loads
// lib/env (validates env at import) + lazily constructs a postgres.js client (no connection until a
// query). These dummies satisfy that. REDIS_URL is set so the suspension index is ENABLED in tests —
// the ioredis client itself is mocked (vi.mock) so nothing connects.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://test:test@localhost:5432/agora_test",
      ACCESS_TOKEN_SECRET: "unit-test-secret-unit-test-secret-unit-test",
      REDIS_URL: "redis://localhost:6379",
    },
  },
});
