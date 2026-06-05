// Steward role: a DB-backed trust tier BETWEEN member and operator. Operators grant steward status
// to trusted community members (project_stewards); isSteward() is read at token mint/refresh time and
// the result is stamped into the access JWT as a `steward` claim, then read back in
// middleware/auth.ts as c.var.auth.isSteward — mirroring the operator flow (lib/operators.ts) but
// DB-backed + per-project (so a grant takes effect on the user's next token refresh). Privilege is
// scoped to the steward routes (routes/steward.ts); stewards do NOT inherit the operator's global
// read bypass.
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projectStewards } from "../db/schema/index.js";

/** True when a profile holds a steward grant in this project. */
export async function isSteward(projectId: string, profileId: string): Promise<boolean> {
  const [row] = await db.select({ id: projectStewards.id }).from(projectStewards)
    .where(and(eq(projectStewards.projectId, projectId), eq(projectStewards.profileId, profileId)))
    .limit(1);
  return !!row;
}

/** Grant steward status (idempotent — no-op if already granted). */
export async function grantSteward(projectId: string, profileId: string, grantedById: string): Promise<void> {
  await db.insert(projectStewards).values({ projectId, profileId, grantedById })
    .onConflictDoNothing({ target: [projectStewards.projectId, projectStewards.profileId] });
}

/** Revoke steward status. */
export async function revokeSteward(projectId: string, profileId: string): Promise<void> {
  await db.delete(projectStewards)
    .where(and(eq(projectStewards.projectId, projectId), eq(projectStewards.profileId, profileId)));
}

/** Profile ids currently granted steward status in this project (newest grant first). */
export async function listStewardIds(projectId: string): Promise<string[]> {
  const rows = await db.select({ profileId: projectStewards.profileId, createdAt: projectStewards.createdAt })
    .from(projectStewards).where(eq(projectStewards.projectId, projectId));
  return rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => r.profileId);
}
