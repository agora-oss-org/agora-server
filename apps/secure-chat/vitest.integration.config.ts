import "dotenv/config";
import { defineConfig } from "vitest/config";
import { normalizeConnString } from "./test/integration/db-url.js";

// Integration tests run against a real Postgres (TEST_DATABASE_URL — the same dedicated cloud Supabase
// test project @agora/api uses; secure-chat shares the main DB in v1). We point the app's DATABASE_URL
// at it so the same @agora/core db client the handlers use connects to the test DB. Isolation is by
// project_id: each test mints its own projects row and scopes everything to it.
//
// REDIS_URL is intentionally LEFT UNSET so the suspension index is disabled and hasActiveSuspension uses
// the authoritative DB read — keeping the suite hermetic (no Redis needed). The Redis fast path is
// covered by the @agora/core unit suite (suspension-index.test.ts) with a mocked client.
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
      REDIS_URL: "", // suspension index disabled in tests → DB read (hermetic)
      // Small IUC restore-blob caps so the size (413) + quota (429) paths are cheap to exercise; only
      // the restore-blob test reads these. CRON_SECRET enables the purge-restore-blobs sweep endpoint.
      MAX_SECURE_RESTORE_BLOB_BYTES: "1024",
      MAX_SECURE_RESTORE_BLOBS_PER_PAIR: "3",
      CRON_SECRET: "integration-cron-secret",
    },
  },
});
