// resolveProject × the resolver seam (spec §3 row 1, §6 item 3). The no-resolver default is
// NOT tested here — it would query the real (lazy) sharedDb; resolver.test.ts covers the
// default identity and the integration suite is the env-mode regression gate. Every test here
// registers a fake resolver. projectIds are unique per test: the middleware's existence cache
// is module-global.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Db } from "../db/context.js";
import { getDb } from "../db/context.js";
import { resetDbResolver, setDbResolver } from "../db/resolver.js";
import { ApiError } from "../http/errors.js";
import type { Variables } from "../http/context.js";
import { resolveProject } from "./project.js";

// Minimal Drizzle-select stub: db.select().from().where().limit() -> rows.
function stubDb(rows: unknown[]): Db {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  } as unknown as Db;
}

function testApp(onProbe: (db: Db) => void) {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((err, c) =>
    err instanceof ApiError ? c.json({ code: err.code }, err.status) : c.json({ code: "internal" }, 500),
  );
  app.get("/v7/:projectId/probe", resolveProject, (c) => {
    onProbe(getDb());
    return c.json({ ok: true });
  });
  return app;
}

const uuid = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(12)}`;

describe("resolveProject × resolver seam", () => {
  afterEach(() => {
    resetDbResolver();
  });

  it("runs the existence check AND the handler scope on the resolved handle", async () => {
    const project = uuid("a");
    const db = stubDb([{ id: project }]);
    const seenByResolver: string[] = [];
    setDbResolver(async (pid) => {
      seenByResolver.push(pid);
      return db;
    });
    let handlerDb: Db | undefined;
    const res = await testApp((d) => (handlerDb = d)).request(`/v7/${project}/probe`);
    expect(res.status).toBe(200);
    expect(seenByResolver).toEqual([project]);
    expect(handlerDb).toBe(db); // getDb() inside the handler IS the resolved handle
  });

  it("404s when the resolved DB has no projects row", async () => {
    const project = uuid("b");
    setDbResolver(async () => stubDb([]));
    const res = await testApp(() => {}).request(`/v7/${project}/probe`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("project/not-found");
  });

  it("propagates a resolver ApiError unchanged (fail closed, no fallback)", async () => {
    const project = uuid("c");
    setDbResolver(async () => {
      throw new ApiError(503, "project/db-unavailable", "Project database unavailable");
    });
    const res = await testApp(() => {}).request(`/v7/${project}/probe`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("project/db-unavailable");
  });
});
