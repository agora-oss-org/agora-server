// Verifies the Agora-issued access token (Bearer) and sets c.var.auth.
// Three flavors:
//   - optionalAuth: attaches auth if a valid token is present, else auth = null
//   - requireAuth:  401s when no valid token
//   - authWall:     group-mount gate with allowlist (pre-sign-in routes); fail closed for the rest
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
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return {
      userId: payload.sub,
      projectId: typeof payload.pid === "string" ? payload.pid : null,
      role: (payload.role as AuthContext["role"]) ?? "visitor",
      isOperator: payload.operator === true,
      isSteward: payload.steward === true,
      isProjectOwner: payload.powner === true,
      isProjectAdmin: payload.padmin === true,
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

/** Verified, non-suspended auth or throw: 401 anonymous/invalid; 403 suspended.
 *  Operators AND project owners bypass the suspension check — operators hold the deployment
 *  god-view and lift suspensions, and an owner can't be locked out of their own project. */
async function enforceAuthed(c: { req: { header: (n: string) => string | undefined } }): Promise<AuthContext> {
  const token = bearer(c);
  const auth = token ? await verify(token) : null;
  if (!auth) throw Errors.unauthorized();
  if (!(auth.isOperator || auth.isProjectOwner) && (await hasActiveSuspension(auth.userId))) {
    throw Errors.forbidden("auth/suspended", "Account suspended");
  }
  return auth;
}

export const requireAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  c.set("auth", await enforceAuthed(c));
  await next();
});

// ─── the auth wall (private by default) ─────────────────────────────────────────
// Agora requires an authenticated account for EVERY project-scoped request except the
// pre-sign-in surface below. Mounted group-wide in apps/api routes/index.ts in place of
// optionalAuth; every future route is therefore authed by default (fail closed).
// Design: docs/superpowers/specs/2026-07-17-auth-wall-private-by-default-design.md

/** The API's ENTIRE anonymous surface. Adding an entry here is a security decision —
 *  it must ship with a spec rationale and the unit test pinning this list must be updated. */
export const AUTH_WALL_ALLOWLIST: { prefixes: readonly string[]; exact: readonly string[] } = {
  // The door itself: sign-up/sign-in/refresh/reset/verify. Its authed members
  // (change-password, account deletion) keep their inner requireAuth.
  prefixes: ["/auth/"],
  exact: [
    "/oauth/authorize",                    // OAuth sign-in starts pre-session
    "/oauth/callback",                     // browser redirect — cannot carry a Bearer header
    "/projects/lean",                      // SDK ReplykeProvider bootstrap (plain axios, fires pre-sign-in)
    "/push-notifications/vapid-public-key",// documented pre-sign-in fetch, rate-limited
    "/crypto/sign-testing-jwt/v2",         // dev stub; signs with a CLIENT-supplied key, no server secret
  ],
};

/** /v7/<projectId>/auth/sign-in → /auth/sign-in (segment 3 onward; c.req.path carries no query string). */
export function projectRelativePath(fullPath: string): string {
  return "/" + fullPath.split("/").slice(3).join("/");
}

export function isWallAllowlisted(relPath: string): boolean {
  return (
    AUTH_WALL_ALLOWLIST.exact.includes(relPath) ||
    AUTH_WALL_ALLOWLIST.prefixes.some((p) => relPath.startsWith(p))
  );
}

/** Group-mount gate: allowlisted paths get optionalAuth semantics (token attached when present,
 *  anonymous allowed, no suspension check — matching today's anonymous-flow behavior); everything
 *  else gets requireAuth semantics exactly. */
export const authWall = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  if (isWallAllowlisted(projectRelativePath(c.req.path))) {
    const token = bearer(c);
    c.set("auth", token ? await verify(token) : null);
    return next();
  }
  c.set("auth", await enforceAuthed(c));
  await next();
});
