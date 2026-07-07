// drainPendingEmbeddings routes each row's content-embedding write through the resolver while
// keeping queue bookkeeping on the ambient handle it read from. embeddings.js is
// mocked (no Voyage); the ambient handle is supplied via runWithDb (calling the drain bare
// would read the REAL lazy sharedDb).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./embeddings.js", () => ({
  embeddingsEnabled: () => true,
  embedText: vi.fn(async () => [0.1, 0.2]),
}));

import { resetDbResolver, runWithDb, setDbResolver, type Db } from "../db/index.js";
import { drainPendingEmbeddings } from "./pending-embeddings.js";

const P1 = "11111111-1111-1111-1111-111111111111";

// Ambient stub: select().from().orderBy().limit() -> pending rows; delete().where() -> ok.
function ambientDb(rows: unknown[]) {
  const del = vi.fn(() => ({ where: async () => [] }));
  return {
    db: {
      select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => rows }) }) }),
      delete: del,
    } as unknown as Db,
    del,
  };
}

// Tenant stub: insert().values().onConflictDoUpdate() -> ok.
function tenantDb() {
  const insert = vi.fn(() => ({ values: () => ({ onConflictDoUpdate: async () => [] }) }));
  return { db: { insert } as unknown as Db, insert };
}

describe("drainPendingEmbeddings × resolver scope", () => {
  afterEach(() => resetDbResolver());

  it("writes the embedding on the row's resolved handle, bookkeeping on the ambient one", async () => {
    const row = { projectId: P1, sourceType: "entity", sourceId: "e1", text: "hello", attempts: 0, createdAt: new Date() };
    const ambient = ambientDb([row]);
    const tenant = tenantDb();
    setDbResolver(async (pid) => {
      expect(pid).toBe(P1);
      return tenant.db;
    });
    const result = await runWithDb(ambient.db, () => drainPendingEmbeddings(10));
    expect(result).toEqual({ drained: 1, failed: 0 });
    expect(tenant.insert).toHaveBeenCalledTimes(1); // content write → resolved handle
    expect(ambient.del).toHaveBeenCalledTimes(1); // queue delete → ambient handle
  });
});
