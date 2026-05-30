// Times each request and records it into the in-memory metering accumulator (lib/metrics.ts).
// Mounted on the v7 group BEFORE projectMiddleware, so it wraps the whole handler for timing yet
// reads c.var.projectId after next() (set during projectMiddleware). Only project-scoped traffic is
// metered. Egress = response Content-Length (uncompressed body bytes; 0 when unknown/streamed).
import { createMiddleware } from "hono/factory";
import type { Variables } from "../http/context.js";
import { recordRequest } from "../lib/metrics.js";

export const meterUsage = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const start = performance.now();
  try {
    await next();
  } finally {
    const projectId = c.var.projectId;
    if (projectId) {
      recordRequest(projectId, {
        bytes: Number(c.res.headers.get("content-length") ?? 0) || 0,
        durationMs: performance.now() - start,
        error: c.res.status >= 400,
      });
    }
  }
});
