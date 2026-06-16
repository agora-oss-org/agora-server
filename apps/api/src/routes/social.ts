// Social-graph READ endpoints (docs/SOCIAL-GRAPH.md §3) — the scorer service is the graph's only
// writer; @agora/api is its read side. Weather is the first Garden surface: one aggregate scalar,
// safe to publish per the magnitude-regime theorem (docs/AGORA-SOCIAL.md §11).
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { Errors } from "../http/errors.js";
import { logger } from "../lib/logger.js";
import { getSocialConfig, transparencyView } from "../lib/social-config.js";
import { isNeo4jError, neo4jEnabled } from "../lib/neo4j.js";
import { getSocialWeather } from "../lib/social-weather.js";
import { getSocialNeighborhood } from "../lib/social-neighborhood.js";
import { getConstellation } from "../lib/social-constellation.js";

export const socialRoutes = new Hono<{ Variables: Variables }>()
  // INVARIANT (docs/AGORA-CORP.md §4, invariant 5): the active tier + enabled analytics are
  // readable by every member — people always know which instrument their instance is. Auth
  // required (not public). Moved here from misc.ts in PR 2; the public path is unchanged.
  .get("/transparency", requireAuth, async (c) =>
    c.json(transparencyView(await getSocialConfig(c.var.projectId))))
  // Gate order matters: config off is a deliberate project choice (400, even with no graph
  // configured); missing/unreachable Neo4j is an operational state (503).
  .get("/weather", requireAuth, async (c) => {
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.graphEnabled || !cfg.weatherEnabled) {
      throw Errors.badRequest("social/weather-disabled", "Community Weather is not enabled for this project");
    }
    if (!neo4jEnabled()) {
      return c.json({ error: "Social graph not configured", code: "social/graph-unavailable" }, 503);
    }
    try {
      return c.json(await getSocialWeather(c.var.projectId, cfg));
    } catch (err) {
      if (!isNeo4jError(err)) throw err; // bugs in our own code surface as 500s via onError, not a fake 503
      logger.warn("social: weather query failed");
      logger.debug({ err, projectId: c.var.projectId }, "social: weather query failed");
      return c.json({ error: "Social graph unavailable", code: "social/graph-unavailable" }, 503);
    }
  })
  // The personal Garden lens: the caller's OWN ties, each with its dyadic brightness B(me, them).
  // Self-view only — keyed on c.var.auth.userId, never another member. Same gate order as /weather.
  .get("/neighborhood", requireAuth, async (c) => {
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.graphEnabled || !cfg.neighborhoodEnabled) {
      throw Errors.badRequest("social/neighborhood-disabled", "The Neighborhood is not enabled for this project");
    }
    if (!neo4jEnabled()) {
      return c.json({ error: "Social graph not configured", code: "social/graph-unavailable" }, 503);
    }
    // Per-member override of the project default: ?includeInteractions=true|false. Absent → the config
    // default (cfg.neighborhoodIncludeInteractions). Any value other than "true"/"false" is ignored.
    const q = c.req.query("includeInteractions");
    const includeInteractions = q === "true" ? true : q === "false" ? false : cfg.neighborhoodIncludeInteractions;
    // Per-request opt-in (no project default — neutral structural edge). Only "true" enables it.
    const includeCoParticipates = c.req.query("includeCoParticipates") === "true";
    try {
      return c.json(await getSocialNeighborhood(c.var.projectId, c.var.auth!.userId, cfg, {
        includeInteractions,
        includeCoParticipates,
      }));
    } catch (err) {
      if (!isNeo4jError(err)) throw err; // bugs in our own code surface as 500s via onError, not a fake 503
      logger.warn("social: neighborhood query failed");
      logger.debug({ err, projectId: c.var.projectId }, "social: neighborhood query failed");
      return c.json({ error: "Social graph unavailable", code: "social/graph-unavailable" }, 503);
    }
  })
  // The anonymous community shape — read straight from the seasonally-materialized snapshot (§12), so
  // there's NO live-Neo4j gate: a project that's never been materialized returns the asOf:null "forming"
  // payload, not a 503. Only the config gate applies.
  .get("/constellation", requireAuth, async (c) => {
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.graphEnabled || !cfg.constellationEnabled) {
      throw Errors.badRequest("social/constellation-disabled", "The Constellation is not enabled for this project");
    }
    return c.json(await getConstellation(c.var.projectId));
  });
