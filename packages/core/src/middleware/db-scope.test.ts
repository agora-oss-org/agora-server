// scopeDbToAuthProject: root-mounted routes (no :projectId) scope their DB by the token's
// project. Two projects → two handles, no cross-talk.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Db } from "../db/context.js";
import { getDb } from "../db/context.js";
import { resetDbResolver, setDbResolver } from "../db/resolver.js";
import type { AuthContext, Variables } from "../http/context.js";
import { scopeDbToAuthProject } from "./db-scope.js";

const dbFor: Record<string, Db> = {
  "p-1": { __fake: "P1" } as unknown as Db,
  "p-2": { __fake: "P2" } as unknown as Db,
};

function appWithAuth(projectId: string | null, onProbe: (db: Db) => void) {
  const auth = { userId: "u1", role: "visitor", projectId, isOperator: false, isSteward: false, isProjectOwner: false, isProjectAdmin: false } as AuthContext;
  return new Hono<{ Variables: Variables }>().get(
    "/probe",
    async (c, next) => {
      c.set("auth", auth); // stand-in for requireAuth
      await next();
    },
    scopeDbToAuthProject,
    (c) => {
      onProbe(getDb());
      return c.json({ ok: true });
    },
  );
}

describe("scopeDbToAuthProject", () => {
  afterEach(() => resetDbResolver());

  it("scopes each request to its token's project handle", async () => {
    setDbResolver(async (pid) => dbFor[pid]!);
    let seen1: Db | undefined, seen2: Db | undefined;
    await appWithAuth("p-1", (d) => (seen1 = d)).request("/probe");
    await appWithAuth("p-2", (d) => (seen2 = d)).request("/probe");
    expect(seen1).toBe(dbFor["p-1"]);
    expect(seen2).toBe(dbFor["p-2"]);
  });

  it("falls back to the ambient handle on a pre-pid token (projectId null)", async () => {
    setDbResolver(async () => dbFor["p-1"]!);
    let seen: Db | undefined;
    await appWithAuth(null, (d) => (seen = d)).request("/probe");
    expect(seen).not.toBe(dbFor["p-1"]); // resolver NOT consulted without a projectId
  });
});
