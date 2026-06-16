// Per-project role grants (owner|admin|steward) — the within-project tier between member and the
// deployment platform-operator. Mirrors the steward-grant pattern, generalized to a role enum.
// Resolution is cached (30s) like social-config; results are folded into JWT claims at mint, so
// request-time guards read c.var.auth with no DB hit.
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/index.js";
import { projectRoles } from "../db/schema/index.js";
import type { Variables, AuthContext } from "../http/context.js";
import { Errors } from "../http/errors.js";

type Ctx = Context<{ Variables: Variables }>;
export type ProjectRole = "owner" | "admin" | "steward";

// ── Guard predicates (fold the hierarchy operator ⊇ owner ⊇ admin ⊇ steward) ──
export function isProjectOwner(a: AuthContext): boolean {
  return a.isOperator || a.isProjectOwner;
}
export function isProjectAdmin(a: AuthContext): boolean {
  return a.isOperator || a.isProjectOwner || a.isProjectAdmin;
}
export function requireProjectOwner(c: Ctx): void {
  if (!isProjectOwner(c.var.auth!)) throw Errors.forbidden("roles/owner-only", "Project owner access required");
}
export function requireProjectAdmin(c: Ctx): void {
  if (!isProjectAdmin(c.var.auth!)) throw Errors.forbidden("roles/admin-only", "Project admin access required");
}

// ── Resolution (cached) ──
const TTL_MS = 30_000;
const cache = new Map<string, { roles: Set<ProjectRole>; at: number }>();
const key = (projectId: string, profileId: string) => `${projectId}:${profileId}`;

/** The set of roles a profile holds in a project (cached). */
export async function getProjectRoles(projectId: string, profileId: string): Promise<Set<ProjectRole>> {
  const k = key(projectId, profileId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.roles;
  const rows = await db.select({ role: projectRoles.role }).from(projectRoles)
    .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.profileId, profileId)));
  const roles = new Set<ProjectRole>(rows.map((r) => r.role as ProjectRole));
  cache.set(k, { roles, at: Date.now() });
  return roles;
}
export function invalidateProjectRoles(projectId: string, profileId: string): void {
  cache.delete(key(projectId, profileId));
}

/** Grant a role (idempotent). */
export async function grantProjectRole(projectId: string, profileId: string, role: ProjectRole, grantedById: string): Promise<void> {
  await db.insert(projectRoles).values({ projectId, profileId, role, grantedById }).onConflictDoNothing();
  invalidateProjectRoles(projectId, profileId);
}
/** Revoke a role. Guards the last owner — atomically, so two concurrent owner-revokes can't both
 *  pass the check and drop the project to zero owners (TOCTOU). The owner check+delete run in one
 *  transaction with `FOR UPDATE` on the owner rows; a racing revoke blocks, then re-reads the reduced
 *  count and correctly throws `roles/last-owner`. Non-owner revokes need no guard. */
export async function revokeProjectRole(projectId: string, profileId: string, role: ProjectRole): Promise<void> {
  if (role === "owner") {
    await db.transaction(async (tx) => {
      // Lock every owner row for this project; serializes concurrent owner-revokes through this point.
      const owners = await tx.select({ profileId: projectRoles.profileId }).from(projectRoles)
        .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.role, "owner")))
        .for("update");
      const targetIsOwner = owners.some((o) => o.profileId === profileId);
      if (targetIsOwner && owners.length <= 1) throw Errors.badRequest("roles/last-owner", "Cannot remove the last owner of a project");
      await tx.delete(projectRoles)
        .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.profileId, profileId), eq(projectRoles.role, "owner")));
    });
  } else {
    await db.delete(projectRoles)
      .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.profileId, profileId), eq(projectRoles.role, role)));
  }
  invalidateProjectRoles(projectId, profileId);
}
/** List grantees of a role (newest first). */
export async function listRoleGrantees(projectId: string, role: ProjectRole): Promise<string[]> {
  const rows = await db.select({ profileId: projectRoles.profileId, at: projectRoles.createdAt }).from(projectRoles)
    .where(and(eq(projectRoles.projectId, projectId), eq(projectRoles.role, role)));
  return rows.sort((x, y) => y.at.getTime() - x.at.getTime()).map((r) => r.profileId);
}
