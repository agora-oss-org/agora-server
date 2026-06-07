import { defineConfig } from "vitest/config";

// Unit suite for the admin app's client logic (lib/*). jsdom gives us window/localStorage so the
// session store + the authed API client behave as they do in the browser; fetch is mocked per test.
// React components are exercised manually via the demo harness, not here — this covers pure logic.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/config.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
