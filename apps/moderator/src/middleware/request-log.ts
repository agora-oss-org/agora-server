// Structured HTTP request logging. Times each request and emits one line per response through the
// shared Pino logger: info for <400, warn for >=400, error for >=500. Mounted app-wide in app.ts.
import { createMiddleware } from "hono/factory";
import type { Variables } from "../http/context.js";
import { logger } from "../lib/logger.js";

export const requestLog = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const start = performance.now();
  try {
    await next();
  } finally {
    const durationMs = Math.round((performance.now() - start) * 10) / 10;
    const fields = { method: c.req.method, path: c.req.path, status: c.res.status, durationMs };
    if (c.res.status >= 500) logger.error(fields, "request");
    else if (c.res.status >= 400) logger.warn(fields, "request");
    else logger.info(fields, "request");
  }
});
