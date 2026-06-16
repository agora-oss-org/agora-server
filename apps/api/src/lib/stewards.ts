// Steward role: a DB-backed trust tier BETWEEN member and operator. Operators grant steward status
// to trusted community members; isSteward() is read at token mint/refresh time and the result is
// stamped into the access JWT as a `steward` claim, then read back in middleware/auth.ts as
// c.var.auth.isSteward — mirroring the operator flow (lib/operators.ts) but DB-backed + per-project
// (so a grant takes effect on the user's next token refresh). Privilege is scoped to the steward
// routes (routes/steward.ts); stewards do NOT inherit the operator's global read bypass.
//
// SOURCE: this module now delegates to `project_roles` (role='steward') via lib/project-roles.ts —
// the unified per-project role grant table (owner|admin|steward). The legacy `project_stewards`
// table is deprecated/retained; these helpers keep their exact signatures so callers are unchanged.
import { getProjectRoles, grantProjectRole, revokeProjectRole, listRoleGrantees } from "./project-roles.js";

/** True when a profile holds a steward grant in this project. */
export async function isSteward(projectId: string, profileId: string): Promise<boolean> {
  return (await getProjectRoles(projectId, profileId)).has("steward");
}

/** Grant steward status (idempotent — no-op if already granted). */
export async function grantSteward(projectId: string, profileId: string, grantedById: string): Promise<void> {
  await grantProjectRole(projectId, profileId, "steward", grantedById);
}

/** Revoke steward status. */
export async function revokeSteward(projectId: string, profileId: string): Promise<void> {
  await revokeProjectRole(projectId, profileId, "steward");
}

/** Profile ids currently granted steward status in this project (newest grant first). */
export async function listStewardIds(projectId: string): Promise<string[]> {
  return listRoleGrantees(projectId, "steward");
}
