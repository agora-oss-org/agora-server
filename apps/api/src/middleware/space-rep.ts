// Parses + validates the space-reputation query params for a router and stashes the resolved directive.
// Mounted per-router with the router's endpoint class; validation (400s) can't be forgotten on a
// mounted route. The enrichment itself happens in each handler via enrichSpaceReputation.
import type { MiddlewareHandler } from "hono";
import type { Variables } from "../http/context.js";
import { resolveDirective } from "../lib/space-reputation-enrich.js";
import { logger } from "../lib/logger.js";

export function spaceRepGate(endpointClass: "context" | "user-direct"): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    const directive = resolveDirective(
      {
        spaceReputationId: c.req.query("spaceReputationId"),
        spaceReputationDescendants: c.req.query("spaceReputationDescendants"),
      },
      endpointClass,
    );
    if (c.req.query("spaceReputationId") === "context") {
      logger.debug("space-reputation 'context' mode requested but deferred; emitting nothing");
    }
    c.set("spaceRep", directive);
    await next();
  };
}
