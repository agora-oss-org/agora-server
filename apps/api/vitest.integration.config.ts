import "dotenv/config";
import { defineConfig } from "vitest/config";
import { normalizeConnString } from "./test/integration/db-url.js";

// Integration tests run against a real Postgres (TEST_DATABASE_URL — a dedicated cloud
// Supabase test project). We point the app's DATABASE_URL at it so the same db/index.ts
// client the handlers use connects to the test DB. Isolation is by project_id: each test
// mints its own projects row and scopes everything to it.
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb) {
  throw new Error("TEST_DATABASE_URL must be set in .env to run integration tests");
}
const dbUrl = normalizeConnString(testDb);

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    fileParallelism: false, // single shared test DB — avoid cross-file races
    hookTimeout: 120_000, // first run applies migrations
    testTimeout: 30_000,
    env: {
      DATABASE_URL: dbUrl,
      ACCESS_TOKEN_SECRET:
        process.env.ACCESS_TOKEN_SECRET ?? "integration-test-secret-integration-test-secret",
      // Hermetic: force the external-service keys empty so the embed/LLM write paths are no-ops
      // (env.ts treats "" as unset). Otherwise dotenv leaks .env keys into the worker and tests
      // would make real Voyage/Anthropic calls — network + cost + non-deterministic. The
      // synthetic-vector test (semantic-search.test.ts) covers match_content offline instead.
      VOYAGE_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      // Hermetic for the same reason: a developer's .env may point NEO4J_URI at a live DozerDB.
      // Forced unset, the weather endpoint's 503 path is deterministic. The opt-in live test
      // (social-weather-live.test.ts) uses TEST_NEO4J_URI with its own driver instead.
      NEO4J_URI: "",
      // Hermetic: a developer's .env sets CRON_SECRET for real cron; leaked into the worker it
      // enables the /internal/cron/* gate and flips env-dependent assertions (digests.test.ts
      // additionally save/unset/restores env.CRON_SECRET around its disabled-path assertion —
      // this force-empty is the belt to that braces). No integration test needs it set.
      CRON_SECRET: "",
      // Hermetic: a developer's .env may set STORAGE_PROVIDER=s3 for local MinIO dev; leaked into
      // the worker it routes uploads at a MinIO that isn't running here. Tests only mock Supabase
      // Storage, so pin the default provider.
      STORAGE_PROVIDER: "supabase",
    },
  },
});
