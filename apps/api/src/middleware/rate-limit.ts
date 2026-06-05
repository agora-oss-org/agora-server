// Edge rate limiting, mounted on /v7/* in app.ts before the route handlers. Off unless configured:
// RATE_LIMIT_MAX caps general per-IP traffic per window; RATE_LIMIT_AUTH_MAX is a stricter cap for
// /auth/* (the brute-force target) and falls back to the general cap when unset. Keys by the real
// client IP (spoof-resistant: RATE_LIMIT_TRUSTED_HOPS from the right of X-Forwarded-For) via a store
// that's in-memory by default or Redis when REDIS_URL is set. Exceeding the window → 429
// { error, code:"common/rate-limited" } + Retry-After. Sets X-RateLimit-Limit/-Remaining.
import { createMiddleware } from "hono/factory";
import type { Variables } from "../http/context.js";
import { env } from "../lib/env.js";
import { clientIp, getStore } from "../lib/rate-limit.js";

const windowMs = env.RATE_LIMIT_WINDOW_SECONDS * 1000;

export const rateLimit = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const isAuth = c.req.path.includes("/auth/");
  const max = isAuth ? (env.RATE_LIMIT_AUTH_MAX ?? env.RATE_LIMIT_MAX) : env.RATE_LIMIT_MAX;
  if (!max) return next(); // this request class isn't limited

  const ip = clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip"), env.RATE_LIMIT_TRUSTED_HOPS);
  const r = await getStore().hit(`${isAuth ? "auth" : "gen"}:${ip}`, max, windowMs);
  c.header("X-RateLimit-Limit", String(r.limit));
  c.header("X-RateLimit-Remaining", String(r.remaining));
  if (!r.allowed) {
    c.header("Retry-After", String(r.retryAfterSec));
    return c.json({ error: "Too many requests", code: "common/rate-limited" }, 429);
  }
  return next();
});
