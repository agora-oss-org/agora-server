// Verifies the Agora-issued access token (Bearer, HS256 over the SHARED ACCESS_TOKEN_SECRET) and
// requires the deployment-operator claim. The admin app already holds such a token, so it
// authenticates to the moderator with no new login. The moderator never mints tokens — it only
// verifies what the API issued.
import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import type { Variables, AuthContext } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { env } from "../lib/env.js";

const secret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);

async function verify(token: string): Promise<AuthContext | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub) return null;
    return {
      userId: payload.sub,
      role: (payload.role as AuthContext["role"]) ?? "visitor",
      isOperator: payload.operator === true,
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

// Admin-facing routes are operator-only: the moderation queue + analyses are a deployment-wide
// (cross-space) god-view, mirroring how the API scopes project-level reports to operators.
export const requireOperator = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = bearer(c);
  const auth = token ? await verify(token) : null;
  if (!auth) throw Errors.unauthorized();
  if (!auth.isOperator) throw Errors.forbidden("auth/not-operator", "Operator access required");
  c.set("auth", auth);
  await next();
});
