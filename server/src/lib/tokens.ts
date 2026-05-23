// Agora token service: short-lived access JWTs + rotating refresh tokens with reuse detection.
// Mirrors the contract the Replyke SDK's auto-refresh assumes (MANIFEST §1):
//   access 30m · refresh 30d · rotation · reuse-detection (revoke whole family) · 30s grace.
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { refreshTokens, profiles } from "../db/schema/index.js";
import { env } from "./env.js";
import { Errors } from "../http/errors.js";

const accessSecret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

/** Sign a 30-minute access JWT (HS256). sub=profileId; verified by middleware/auth.ts. */
export async function signAccessToken(profileId: string, role: string): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(profileId)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL}s`)
    .sign(accessSecret);
}

/** Persist a new refresh token (within `familyId`, or a fresh family) and return the raw value. */
async function issueRefreshToken(projectId: string, profileId: string, familyId: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(refreshTokens).values({
    projectId,
    profileId,
    familyId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
  });
  return raw;
}

/** Mint a full session (access + refresh). Starts a new family unless one is supplied (rotation). */
export async function mintSession(projectId: string, profileId: string, role: string, familyId?: string): Promise<SessionTokens> {
  const family = familyId ?? randomUUID();
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(profileId, role),
    issueRefreshToken(projectId, profileId, family),
  ]);
  return { accessToken, refreshToken };
}

async function revokeFamily(familyId: string): Promise<void> {
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.familyId, familyId));
}

/**
 * Validate a refresh token and rotate it. Throws 401 on invalid/expired tokens, and on REUSE
 * (a spent/revoked token presented outside the grace window) revokes the entire family first.
 */
export async function rotateRefreshToken(projectId: string, raw: string): Promise<SessionTokens> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.projectId, projectId), eq(refreshTokens.tokenHash, sha256(raw))))
    .limit(1);
  if (!row) throw Errors.unauthorized("auth/invalid-refresh", "Invalid refresh token");

  const now = Date.now();
  const graceMs = env.REFRESH_TOKEN_GRACE_SECONDS * 1000;

  // Already revoked → token theft / family compromised.
  if (row.revoked) {
    await revokeFamily(row.familyId);
    throw Errors.unauthorized("auth/refresh-reused", "Refresh token reuse detected");
  }
  // Already rotated: allow once inside the grace window (racing tabs); else it's reuse.
  if (row.rotatedAt) {
    if (now <= row.rotatedAt.getTime() + graceMs) {
      const role = await profileRole(row.profileId);
      return mintSession(projectId, row.profileId, role, row.familyId);
    }
    await revokeFamily(row.familyId);
    throw Errors.unauthorized("auth/refresh-reused", "Refresh token reuse detected");
  }
  if (row.expiresAt.getTime() < now) throw Errors.unauthorized("auth/refresh-expired", "Refresh token expired");

  // Normal rotation: spend this token, mint a successor in the same family.
  await db.update(refreshTokens).set({ rotatedAt: new Date() }).where(eq(refreshTokens.id, row.id));
  const role = await profileRole(row.profileId);
  return mintSession(projectId, row.profileId, role, row.familyId);
}

/** Sign-out: revoke the family of the presented refresh token (this session). */
export async function revokeRefreshToken(projectId: string, raw: string): Promise<void> {
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.projectId, projectId), eq(refreshTokens.tokenHash, sha256(raw))))
    .limit(1);
  if (row) await revokeFamily(row.familyId);
}

/** Revoke every refresh family for a profile (e.g. password change / global sign-out). */
export async function revokeAllForProfile(profileId: string): Promise<void> {
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.profileId, profileId));
}

async function profileRole(profileId: string): Promise<string> {
  const [p] = await db.select({ role: profiles.role }).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  return p?.role ?? "visitor";
}
