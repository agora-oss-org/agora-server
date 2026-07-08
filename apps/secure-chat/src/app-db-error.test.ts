// createSecureApp()'s onError maps a tenant-DB *connection* failure to a retryable 503
// project/db-unavailable (mirroring @agora/api), while a query/constraint error stays 500
// common/internal. secure-chat rides the same per-tenant DB seam, so it needs the same mapping.
// Drives the app with a resolver whose handle throws at query time (resolveProject's existence
// check) — the exact shape the CR targets. No real DB.
import { afterEach, describe, expect, it } from "vitest";
import { resetDbResolver, setDbResolver, type Db } from "@agora/core/db";
import { createSecureApp } from "./app.js";

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

const CONN_PROJECT = "dead0000-0000-4000-8000-000000000011";
const QUERY_PROJECT = "dead0000-0000-4000-8000-000000000012";

describe("secure-chat app.onError × tenant DB reachability", () => {
  afterEach(() => resetDbResolver());

  it("maps a connection failure (ECONNREFUSED at query time) to 503 project/db-unavailable", async () => {
    const econnrefused = Object.assign(new Error("write ECONNREFUSED 10.0.0.9:6543"), { code: "ECONNREFUSED" });
    setDbResolver(async () => dbThatThrows(econnrefused));

    const res = await createSecureApp().request(`/v7/${CONN_PROJECT}/secure-chat/conversations`);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Project database unavailable", code: "project/db-unavailable" });
  });

  it("leaves a query/constraint error (SQLSTATE 23503) as 500 common/internal", async () => {
    const fkViolation = Object.assign(new Error("insert violates foreign key"), { code: "23503" });
    setDbResolver(async () => dbThatThrows(fkViolation));

    const res = await createSecureApp().request(`/v7/${QUERY_PROJECT}/secure-chat/conversations`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error", code: "common/internal" });
  });
});
