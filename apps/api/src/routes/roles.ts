// /v7/:projectId/roles/* — per-project role grant management (owner|admin|steward).
//
// Gating: project-admin (and up) may VIEW the grant table; only the project owner (or platform
// operator) may grant/revoke. The matrix is encoded in the project-roles guards — requireProjectAdmin
// passes for operator+owner+admin; requireProjectOwner passes for operator+owner. Last-owner revoke
// is blocked inside revokeProjectRole (throws roles/last-owner).
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { profiles } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import { loadUsers } from "../lib/shape.js";
import { parseBody, grantRoleSchema } from "../lib/validation.js";
import { Errors } from "../http/errors.js";
import {
  requireProjectAdmin, requireProjectOwner,
  grantProjectRole, revokeProjectRole, listRoleGrantees,
} from "../lib/project-roles.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const rolesRoutes = new Hono<{ Variables: Variables }>()
  // List grantees grouped by role. Project-admin (and up) may view; only owner mutates.
  .get("/", requireAuth, async (c) => {
    requireProjectAdmin(c);
    const projectId = c.var.projectId;
    const out: Record<string, unknown[]> = {};
    for (const role of ["owner", "admin", "steward"] as const) {
      const ids = await listRoleGrantees(projectId, role);
      const users = await loadUsers(projectId, ids);
      out[role] = ids.map((id) => users.get(id)).filter(Boolean);
    }
    return c.json({ roles: out });
  })
  // Grant a role (owner-gated). Idempotent; target must be a profile in this project.
  .post("/", requireAuth, async (c) => {
    requireProjectOwner(c);
    const projectId = c.var.projectId;
    const body = parseBody(grantRoleSchema, await c.req.json().catch(() => ({})), "roles");
    const [p] = await getDb().select({ id: profiles.id }).from(profiles)
      .where(and(eq(profiles.projectId, projectId), eq(profiles.id, body.userId))).limit(1);
    if (!p) throw Errors.notFound("roles/user-not-found", "User not found in this project");
    await grantProjectRole(projectId, body.userId, body.role, c.var.auth!.userId);
    logger.info({ projectId, profileId: body.userId, role: body.role, grantedBy: c.var.auth!.userId }, "roles: granted");
    return c.json({ success: true }, 201);
  })
  // Revoke a role (owner-gated). Last-owner removal is blocked inside revokeProjectRole.
  .delete("/:userId/:role", requireAuth, async (c) => {
    requireProjectOwner(c);
    const userId = c.req.param("userId");
    const role = c.req.param("role");
    // Validate both path params before they hit the uuid/enum columns (fail closed, clean 400 not 500;
    // parity with POST's zod-validated body).
    if (!UUID_RE.test(userId)) throw Errors.badRequest("roles/invalid-user", "userId must be a UUID", "userId");
    if (role !== "owner" && role !== "admin" && role !== "steward") throw Errors.badRequest("roles/invalid-role", "Unknown role");
    await revokeProjectRole(c.var.projectId, userId, role);
    logger.info({ projectId: c.var.projectId, profileId: userId, role, revokedBy: c.var.auth!.userId }, "roles: revoked");
    return c.json({ success: true });
  });
