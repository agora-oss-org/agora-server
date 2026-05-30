// Edge rate limiting, mounted on /v7/* in app.ts before the route handlers. Off unless configured:
// RATE_LIMIT_MAX caps general per-IP traffic per window; RATE_LIMIT_AUTH_MAX is a stricter cap for
// /auth/* (the brute-force target) and falls back to the general cap when unset. Keys by client IP
// from the proxy headers. Exceeding the window → 429 { error, code:"common/rate-limited" } +
// Retry-After. Sets X-RateLimit-Limit/-Remaining on every limited response.
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Variables } from "../http/context.js";
import { env } from "../lib/env.js";
import { hit } from "../lib/rate-limit.js";

const windowMs = env.RATE_LIMIT_WINDOW_SECONDS * 1000;

// First X-Forwarded-For hop (the real client), else X-Real-IP. A reverse proxy must set one of these
// for per-client limiting; un-proxied callers share the "unknown" bucket (acceptable — limiting is
// opt-in and meant to run behind a proxy).
function clientKey(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

export const rateLimit = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const isAuth = c.req.path.includes("/auth/");
  const max = isAuth ? (env.RATE_LIMIT_AUTH_MAX ?? env.RATE_LIMIT_MAX) : env.RATE_LIMIT_MAX;
  if (!max) return next(); // this request class isn't limited

  const r = hit(`${isAuth ? "auth" : "gen"}:${clientKey(c)}`, max, windowMs);
  c.header("X-RateLimit-Limit", String(r.limit));
  c.header("X-RateLimit-Remaining", String(r.remaining));
  if (!r.allowed) {
    c.header("Retry-After", String(r.retryAfterSec));
    return c.json({ error: "Too many requests", code: "common/rate-limited" }, 429);
  }
  return next();
});
