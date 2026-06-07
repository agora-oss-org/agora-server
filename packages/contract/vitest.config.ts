import { defineConfig } from "vitest/config";

// Unit suite for the shared contract: pure types + zod schemas + the pagination envelope.
// No I/O, no env — these are the SDK-compatibility guarantees ("the contract is the constraint"),
// so they're fast and run with `pnpm -r test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
});
