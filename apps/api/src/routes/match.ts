// /v7/:projectId/match/* — user matching. v7.8.2 ships the request CONTRACT only; the facet/embedding
// engine is a separate future spec (see docs/superpowers/specs/2026-07-07-sdk-v7.8.2-sync-design.md §4.6).
// The stub validates the body and resolves to "no matches" so useMatchUsers settles cleanly.
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { parseBody } from "../lib/validation.js";
import { matchUsersSchema } from "@agora-server/contract";

export const matchRoutes = new Hono<{ Variables: Variables }>()
  .post("/users", requireAuth, async (c) => {
    parseBody(matchUsersSchema, await c.req.json().catch(() => ({})), "match"); // validates mode + directed-requires-query (400)
    return c.json({ results: [] });
  });
