// app.onError maps a tenant-DB *connection* failure to a retryable 503 project/db-unavailable, while
// a query/constraint error still surfaces as 500 common/internal. Drives createApp() in-process with a
// resolver whose handle looks healthy (getDbForDsn is lazy) but throws at query time — the exact shape
// the CR targets: the resolver can't see a dead DSN, so the failure only appears on the first query
// (resolveProject's existence check). No real DB.
import { afterEach, describe, expect, it } from "vitest";
import { resetDbResolver, setDbResolver, type Db } from "./db/index.js";
import { createApp } from "./app.js";

// A Db whose select-chain rejects with `err` at .limit() — mirrors resolveProject's
// db.select({id}).from(projects).where(...).limit(1).
function dbThatThrows(err: unknown): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.reject(err),
  };
  return { select: () => chain } as unknown as Db;
}

// Distinct, valid UUIDs that no other test caches in resolveProject's existence-cache.
const CONN_PROJECT = "dead0000-0000-4000-8000-000000000001";
const QUERY_PROJECT = "dead0000-0000-4000-8000-000000000002";

describe("app.onError × tenant DB reachability", () => {
  afterEach(() => resetDbResolver());

  it("maps a connection failure (ECONNREFUSED at query time) to 503 project/db-unavailable", async () => {
    const econnrefused = Object.assign(new Error("write ECONNREFUSED 10.0.0.9:6543"), { code: "ECONNREFUSED" });
    setDbResolver(async () => dbThatThrows(econnrefused));

    const res = await createApp().request(`/v7/${CONN_PROJECT}/entities`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Project database unavailable", code: "project/db-unavailable" });
  });

  it("leaves a query/constraint error (SQLSTATE 23503) as 500 common/internal", async () => {
    const fkViolation = Object.assign(new Error("insert violates foreign key"), { code: "23503" });
    setDbResolver(async () => dbThatThrows(fkViolation));

    const res = await createApp().request(`/v7/${QUERY_PROJECT}/entities`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error", code: "common/internal" });
  });
});
