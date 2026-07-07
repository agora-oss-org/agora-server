// /internal/moderation/apply runs applyClientModeration inside the resolved project scope
//. applyClientModeration is mocked to capture getDb() at call time; the
// fake resolver maps the body's projectId to a stub handle. MODERATION_SERVICE_SECRET is
// mutated on the parsed env object (the digests-test precedent) and restored.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/client-moderation.js", () => ({
  applyClientModeration: vi.fn(),
}));

import { getDb, resetDbResolver, setDbResolver, type Db } from "./db/index.js";
import { env } from "./lib/env.js";
import { applyClientModeration } from "./lib/client-moderation.js";
import { createApp } from "./app.js";

const stub = { __fake: "tenant" } as unknown as Db;
const PROJECT = "11111111-1111-1111-1111-111111111111";

describe("moderation apply × resolver scope", () => {
  const savedSecret = env.MODERATION_SERVICE_SECRET;
  beforeEach(() => {
    (env as { MODERATION_SERVICE_SECRET?: string }).MODERATION_SERVICE_SECRET = "test-moderation-secret";
  });
  afterEach(() => {
    (env as { MODERATION_SERVICE_SECRET?: string }).MODERATION_SERVICE_SECRET = savedSecret;
    resetDbResolver();
    vi.mocked(applyClientModeration).mockReset();
  });

  it("invokes applyClientModeration inside the resolved project's ALS scope", async () => {
    let capturedDb: Db | undefined;
    vi.mocked(applyClientModeration).mockImplementation(async () => {
      capturedDb = getDb();
      return true;
    });
    setDbResolver(async (pid) => {
      expect(pid).toBe(PROJECT);
      return stub;
    });
    const res = await createApp().request("/internal/moderation/apply", {
      method: "POST",
      headers: { "x-moderation-secret": "test-moderation-secret", "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT, targetType: "entity", targetId: "22222222-2222-2222-2222-222222222222", status: "removed" }),
    });
    expect(res.status).toBe(200);
    expect(capturedDb).toBe(stub);
  });
});
