// Resolves the :projectId path segment and stashes it on the context.
// Mirrors Replyke's /v7/:projectId/... addressing.
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { db } from "../db/index.js";
import { projects } from "../db/schema/index.js";

const cache = new Map<string, boolean>();

export const resolveProject = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const projectId = c.req.param("projectId");
  if (!projectId) throw Errors.badRequest("project/missing", "Missing projectId in path");

  if (!cache.get(projectId)) {
    const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!rows[0]) throw Errors.notFound("project/not-found", "Unknown project");
    cache.set(projectId, true);
  }

  c.set("projectId", projectId);
  await next();
});
