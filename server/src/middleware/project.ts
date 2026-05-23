// Resolves the :projectId path segment and stashes it on the context.
// Mirrors Replyke's /v7/:projectId/... addressing.
import { createMiddleware } from "hono/factory";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { supabase } from "../lib/supabase.js";

const cache = new Map<string, boolean>();

export const resolveProject = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const projectId = c.req.param("projectId");
  if (!projectId) throw Errors.badRequest("project/missing", "Missing projectId in path");

  if (!cache.get(projectId)) {
    const { data, error } = await supabase.from("projects").select("id").eq("id", projectId).maybeSingle();
    if (error) throw Errors.badRequest("project/lookup-failed", error.message);
    if (!data) throw Errors.notFound("project/not-found", "Unknown project");
    cache.set(projectId, true);
  }

  c.set("projectId", projectId);
  await next();
});
