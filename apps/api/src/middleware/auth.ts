// Verifies the Agora-issued access token (Bearer) and sets c.var.auth.
// Two flavors:
//   - optionalAuth: attaches auth if a valid token is present, else auth = null
//   - requireAuth:  401s when no valid token
//
// NOTE: token MINTING + refresh rotation/reuse-detection lives in services/tokens.ts
// (the hard part — see docs/MANIFEST.md §1). This middleware only VERIFIES.
import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import type { Variables, AuthContext } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { env } from "../lib/env.js";
import { hasActiveSuspension } from "../lib/suspensions.js";

const secret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);

async function verify(token: string): Promise<AuthContext | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub) return null;
    return {
      userId: payload.sub,
      role: (payload.role as AuthContext["role"]) ?? "visitor",
      isOperator: payload.operator === true,
      isSteward: payload.steward === true,
    };
  } catch {
    return null;
  }
}

function bearer(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const h = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7);
}

export const optionalAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = bearer(c);
  c.set("auth", token ? await verify(token) : null);
  await next();
});

export const requireAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = bearer(c);
  const auth = token ? await verify(token) : null;
  if (!auth) throw Errors.unauthorized();
  // Block suspended users on every authed request (the access token outlives a fresh suspension).
  // Operators bypass — they hold the deployment god-view and lift suspensions (avoids self-lockout).
  if (!auth.isOperator && (await hasActiveSuspension(auth.userId))) {
    throw Errors.forbidden("auth/suspended", "Account suspended");
  }
  c.set("auth", auth);
  await next();
});
