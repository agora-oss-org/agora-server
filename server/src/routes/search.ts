// /v7/:projectId/search/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const searchRoutes = new Hono<{ Variables: Variables }>()
  // semantic: embed query -> supabase.rpc('match_entities', {...})
  .get("/content", (c) => { throw Errors.notImplemented("search/content"); })
  .get("/spaces", (c) => { throw Errors.notImplemented("search/spaces"); })
  .get("/users", (c) => { throw Errors.notImplemented("search/users"); });
