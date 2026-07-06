import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
vi.mock("../db/index.js", () => ({ getDb: () => ({ execute: (...a: unknown[]) => execute(...a) }) }));

import { recordRequest, flushMetrics } from "./metrics.js";

// Postgres foreign_key_violation, as the driver surfaces it (Drizzle wraps it under `.cause`).
function fkError(): Error {
  const driver = Object.assign(new Error("FK violation"), { code: "23503" });
  return Object.assign(new Error("Failed query"), { cause: driver });
}

const sample = { bytes: 0, durationMs: 1, error: false };

beforeEach(() => {
  execute.mockReset();
  // Drain any buckets left by a prior test so each case starts clean.
  execute.mockResolvedValue(undefined);
  return flushMetrics();
});

describe("flushMetrics", () => {
  it("drops a bucket for a deleted project (FK violation) instead of re-queuing it", async () => {
    recordRequest("proj-gone", sample);
    execute.mockRejectedValueOnce(fkError());
    await flushMetrics();
    expect(execute).toHaveBeenCalledTimes(1);

    // Poison-pill check: the dropped bucket must NOT come back on the next flush.
    execute.mockClear();
    await flushMetrics();
    expect(execute).not.toHaveBeenCalled();
  });

  it("re-queues a bucket on a transient error so nothing is lost", async () => {
    recordRequest("proj-live", sample);
    execute.mockRejectedValueOnce(new Error("connection reset"));
    await flushMetrics();
    expect(execute).toHaveBeenCalledTimes(1);

    // The bucket survived — a follow-up flush retries it (and this time succeeds).
    execute.mockClear();
    execute.mockResolvedValue(undefined);
    await flushMetrics();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("isolates a failing bucket so a healthy project still flushes", async () => {
    recordRequest("proj-a", sample);
    recordRequest("proj-b", sample);
    // First bucket FK-fails (dropped), second must still be attempted.
    execute.mockRejectedValueOnce(fkError()).mockResolvedValue(undefined);
    await flushMetrics();
    expect(execute).toHaveBeenCalledTimes(2);

    // Only the FK-dropped bucket is gone; the healthy one already landed — nothing re-queued.
    execute.mockClear();
    await flushMetrics();
    expect(execute).not.toHaveBeenCalled();
  });
});
