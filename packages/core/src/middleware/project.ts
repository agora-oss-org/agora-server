// Resolves the :projectId path segment and stashes it on the context.
// Mirrors Replyke's /v7/:projectId/... addressing.
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/index.js";

const cache = new Map<string, boolean>();

// projects.id is a uuid column — passing a non-uuid segment (e.g. /v7/health) makes Postgres throw
// "invalid input syntax for type uuid", which would surface as a 500. Reject those up front as 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const resolveProject = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const projectId = c.req.param("projectId");
  if (!projectId) throw Errors.badRequest("project/missing", "Missing projectId in path");
  if (!UUID_RE.test(projectId)) throw Errors.notFound("project/not-found", "Unknown project");

  if (!cache.get(projectId)) {
    const rows = await getDb().select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!rows[0]) throw Errors.notFound("project/not-found", "Unknown project");
    cache.set(projectId, true);
  }

  c.set("projectId", projectId);
  await next();
});
