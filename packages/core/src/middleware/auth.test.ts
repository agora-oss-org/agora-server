// The `pid` access-token claim → c.var.auth.projectId (hosting-enablement spec §3, connections
// row). Tests optionalAuth (same verify() path as requireAuth, without the suspension lookup —
// keeps the test Redis/DB-free). ACCESS_TOKEN_SECRET comes from vitest.config.ts dummies.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { AuthContext } from "../http/context.js";
import type { Variables } from "../http/context.js";
import { env } from "../lib/env.js";
import { optionalAuth } from "./auth.js";

const secret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);

async function token(claims: Record<string, unknown>) {
  return new SignJWT({ role: "visitor", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("00000000-0000-0000-0000-000000000001")
    .setExpirationTime("5m")
    .sign(secret);
}

async function authFor(claims: Record<string, unknown>): Promise<AuthContext | null> {
  let seen: AuthContext | null = null;
  const app = new Hono<{ Variables: Variables }>().get("/probe", optionalAuth, (c) => {
    seen = c.var.auth;
    return c.json({ ok: true });
  });
  await app.request("/probe", { headers: { authorization: `Bearer ${await token(claims)}` } });
  return seen;
}

describe("auth verify × pid claim", () => {
  it("surfaces the pid claim as auth.projectId", async () => {
    const auth = await authFor({ pid: "11111111-1111-1111-1111-111111111111" });
    expect(auth?.projectId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("is null on a pre-pid token (backward compatible)", async () => {
    const auth = await authFor({});
    expect(auth?.projectId).toBeNull();
  });

  it("ignores a non-string pid", async () => {
    const auth = await authFor({ pid: 42 });
    expect(auth?.projectId).toBeNull();
  });
});
