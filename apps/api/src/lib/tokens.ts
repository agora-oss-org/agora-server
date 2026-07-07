// Agora token service: short-lived access JWTs + rotating refresh tokens with reuse detection.
// Mirrors the contract the Replyke SDK's auto-refresh assumes (MANIFEST §1):
//   access 30m · refresh 30d · rotation · reuse-detection (revoke whole family) · 30s grace.
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { refreshTokens, profiles } from "../db/schema/index.js";
import { env } from "./env.js";
import { isOperator } from "./operators.js";
import { getProjectRoles } from "./project-roles.js";
import { logger } from "./logger.js";
import { Errors } from "../http/errors.js";

const accessSecret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

/** Sign a 30-minute access JWT (HS256). sub=profileId; verified by middleware/auth.ts.
 *  `operator` carries the deployment-operator flag, `steward` the conflict-resolution role, and
 *  `powner`/`padmin` the per-project owner/admin grants, so handlers read all of them without a DB
 *  hit. `projectId` is stamped as the `pid` claim, so root-mounted routes can learn their project
 *  from the token alone (c.var.auth.projectId). */
export async function signAccessToken(projectId: string, profileId: string, role: string, operator = false, steward = false, owner = false, admin = false): Promise<string> {
  return new SignJWT({ role, operator, steward, powner: owner, padmin: admin, pid: projectId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(profileId)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL}s`)
    .sign(accessSecret);
}

/** Persist a new refresh token (within `familyId`, or a fresh family) and return the raw value. */
async function issueRefreshToken(projectId: string, profileId: string, familyId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await getDb().insert(refreshTokens).values({
    projectId,
    profileId,
    familyId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
  });
  return raw;
}

/** Mint a full session (access + refresh). Starts a new family unless one is supplied (rotation).
 *  `operator` + `steward` + `owner`/`admin` flow into the access-token claims (caller computes them
 *  from the profile + project roles). */
export async function mintSession(projectId: string, profileId: string, role: string, operator = false, steward = false, owner = false, admin = false, familyId?: string): Promise<SessionTokens> {
  const family = familyId ?? randomUUID();
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(projectId, profileId, role, operator, steward, owner, admin),
    issueRefreshToken(projectId, profileId, family),
  ]);
  return { accessToken, refreshToken };
}

async function revokeFamily(familyId: string): Promise<void> {
  await getDb().update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.familyId, familyId));
}

/**
 * Validate a refresh token and rotate it. Throws 401 on invalid/expired tokens, and on REUSE
 * (a spent/revoked token presented outside the grace window) revokes the entire family first.
 */
export async function rotateRefreshToken(projectId: string, raw: string): Promise<SessionTokens & { profileId: string }> {
  const [row] = await getDb()
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.projectId, projectId), eq(refreshTokens.tokenHash, sha256(raw))))
    .limit(1);
  if (!row) {
    logger.info({ projectId }, "auth: refresh rejected — unknown token");
    throw Errors.unauthorized("auth/invalid-refresh", "Invalid refresh token");
  }

  const now = Date.now();
  const graceMs = env.REFRESH_TOKEN_GRACE_SECONDS * 1000;

  // Already revoked → token theft / family compromised.
  if (row.revoked) {
    logger.warn({ projectId, profileId: row.profileId, familyId: row.familyId }, "auth: refresh token reuse detected — revoking family");
    await revokeFamily(row.familyId);
    throw Errors.unauthorized("auth/refresh-reused", "Refresh token reuse detected");
  }
  // Already rotated: allow once inside the grace window (racing tabs); else it's reuse.
  if (row.rotatedAt) {
    if (now <= row.rotatedAt.getTime() + graceMs) {
      logger.debug({ projectId, profileId: row.profileId, familyId: row.familyId }, "auth: refresh replay within grace window");
      const { role, operator, owner, admin, steward } = await profileAuthBits(projectId, row.profileId);
      return { ...(await mintSession(projectId, row.profileId, role, operator, steward, owner, admin, row.familyId)), profileId: row.profileId };
    }
    logger.warn({ projectId, profileId: row.profileId, familyId: row.familyId }, "auth: rotated refresh token reused past grace — revoking family");
    await revokeFamily(row.familyId);
    throw Errors.unauthorized("auth/refresh-reused", "Refresh token reuse detected");
  }
  if (row.expiresAt.getTime() < now) {
    logger.info({ projectId, profileId: row.profileId }, "auth: refresh rejected — expired");
    throw Errors.unauthorized("auth/refresh-expired", "Refresh token expired");
  }

  // Normal rotation: spend this token, mint a successor in the same family.
  await getDb().update(refreshTokens).set({ rotatedAt: new Date() }).where(eq(refreshTokens.id, row.id));
  logger.debug({ projectId, profileId: row.profileId, familyId: row.familyId }, "auth: refresh rotated");
  const { role, operator, owner, admin, steward } = await profileAuthBits(projectId, row.profileId);
  return { ...(await mintSession(projectId, row.profileId, role, operator, steward, owner, admin, row.familyId)), profileId: row.profileId };
}

/** Sign-out: revoke the family of the presented refresh token (this session). */
export async function revokeRefreshToken(projectId: string, raw: string): Promise<void> {
  const [row] = await getDb()
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.projectId, projectId), eq(refreshTokens.tokenHash, sha256(raw))))
    .limit(1);
  if (row) await revokeFamily(row.familyId);
}

/** Revoke every refresh family for a profile (e.g. password change / global sign-out). */
export async function revokeAllForProfile(profileId: string): Promise<void> {
  await getDb().update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.profileId, profileId));
}

// Re-derive role + operator + per-project owner/admin/steward status for a profile (used on refresh,
// where we only hold the profile id). Project roles are project-scoped, so this needs the projectId
// too. `steward` folds the hierarchy operator ⊇ owner ⊇ admin ⊇ steward (an owner/admin is a steward).
async function profileAuthBits(projectId: string, profileId: string): Promise<{ role: string; operator: boolean; owner: boolean; admin: boolean; steward: boolean }> {
  const [p] = await getDb().select({ id: profiles.id, role: profiles.role, email: profiles.email })
    .from(profiles).where(eq(profiles.id, profileId)).limit(1);
  if (!p) return { role: "visitor", operator: false, owner: false, admin: false, steward: false };
  const roles = await getProjectRoles(projectId, p.id);
  return {
    role: p.role,
    operator: isOperator(p),
    owner: roles.has("owner"),
    admin: roles.has("admin"),
    steward: roles.has("steward") || roles.has("admin") || roles.has("owner"),
  };
}
