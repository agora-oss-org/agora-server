// flushMetrics resolves each bucket's project handle: two projects with
// a fake resolver → each upsert lands on its own stub; an unresolvable project's bucket is
// dropped, not re-queued (poison-pill guard, mirrors the FK-violation precedent).
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDbResolver, setDbResolver, type Db } from "../db/index.js";
import { flushMetrics, recordRequest } from "./metrics.js";

function stubExec() {
  const execute = vi.fn(async () => []);
  return { db: { execute } as unknown as Db, execute };
}

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";

describe("flushMetrics × resolver scope", () => {
  afterEach(async () => {
    resetDbResolver();
    // drain any leftover buckets against a swallow-all resolver so tests stay independent
    setDbResolver(async () => stubExec().db);
    await flushMetrics();
    resetDbResolver();
  });

  it("flushes each project's bucket on its own resolved handle", async () => {
    const a = stubExec();
    const b = stubExec();
    setDbResolver(async (pid) => (pid === P1 ? a.db : b.db));
    recordRequest(P1, { bytes: 10, durationMs: 5, error: false });
    recordRequest(P2, { bytes: 20, durationMs: 7, error: true });
    await flushMetrics();
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(b.execute).toHaveBeenCalledTimes(1);
  });

  it("drops (does not re-queue) a bucket whose project cannot resolve", async () => {
    const good = stubExec();
    setDbResolver(async (pid) => {
      if (pid === P1) throw new Error("unknown project");
      return good.db;
    });
    recordRequest(P1, { bytes: 10, durationMs: 5, error: false });
    await flushMetrics(); // must not throw
    // flush again: if the bucket had been merged back, the resolver would be hit for P1 again
    const calls: string[] = [];
    resetDbResolver();
    setDbResolver(async (pid) => {
      calls.push(pid);
      return good.db;
    });
    await flushMetrics();
    expect(calls).not.toContain(P1); // dropped, not poison-pilled
  });
});
