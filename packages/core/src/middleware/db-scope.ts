// Runs the rest of the chain inside the ALS scope of the AUTHED USER's project DB. For
// root-mounted routes with no :projectId segment (the connections module) the token's `pid`
// claim names the project — the token-first rule: it avoids the
// bootstrap problem of needing a DB to find the profile that names the DB. A pre-pid token
// (minted before the claim existed) falls back to the ambient handle — identical behavior in
// a single-tenant deployment, where every handle is the shared DB anyway.
// Order matters: insert AFTER requireAuth (this reads c.var.auth).
import { createMiddleware } from "hono/factory";
import type { Variables } from "../http/context.js";
import { getDb, runWithDb } from "../db/index.js";
import { resolveDbFor } from "../db/resolver.js";

export const scopeDbToAuthProject = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const projectId = c.var.auth?.projectId ?? null;
  const db = projectId ? await resolveDbFor(projectId) : getDb();
  await runWithDb(db, () => next());
});
