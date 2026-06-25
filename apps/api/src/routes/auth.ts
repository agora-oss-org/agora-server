// /v7/:projectId/auth/*
// Identity is backed by Supabase Auth (passwords + confirmation/reset emails); Agora mints its
// own access/refresh tokens on top (lib/tokens.ts) and keeps a `profiles` row per auth user.
// verify-external-user bypasses Supabase: RS256 verify against the project's public key.
import { Hono } from "hono";
import { createPublicKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { importSPKI, jwtVerify } from "jose";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { profiles, userSuspensions, projects } from "../db/schema/index.js";
import { getAuthProvider } from "../lib/auth/index.js";
import { mintSession, rotateRefreshToken, revokeRefreshToken, revokeAllForProfile } from "../lib/tokens.js";
import { requestAccountDeletion, verifyAccountDeletionCode, resolveDeletionMode } from "../lib/account-deletion.js";
import { isOperator } from "../lib/operators.js";
import { getProjectRoles } from "../lib/project-roles.js";
import { shapeAuthUser } from "../lib/shape.js";
import { logger } from "../lib/logger.js";
import * as webhooks from "../lib/webhooks.js";
import {
  parseBody, signUpSchema, signInSchema, refreshSchema, signOutSchema,
  changePasswordSchema, emailSchema, verifyEmailSchema, resetPasswordSchema, externalUserSchema,
  confirmAccountDeletionSchema,
} from "../lib/validation.js";

type ProfileRow = typeof profiles.$inferSelect;

// Find a project's profile for a Supabase auth user.
async function profileByAuthUser(projectId: string, authUserId: string): Promise<ProfileRow | null> {
  const [row] = await db.select().from(profiles)
    .where(and(eq(profiles.projectId, projectId), eq(profiles.authUserId, authUserId))).limit(1);
  return row ?? null;
}

// Create-or-return the profile for a freshly authenticated Supabase user.
// Derive a default username from an email local-part so new accounts aren't nameless (the SDK/UI
// falls back to a raw id slice otherwise). Sanitized to [a-z0-9_-]; the `+tag` is dropped. The
// `(project_id, username)` unique constraint means we must avoid collisions: if the base is taken,
// suffix with the auth user's id prefix (unique per user) → no insert failure.
async function defaultUsername(projectId: string, email?: string, authUserId?: string): Promise<string | undefined> {
  if (!email) return undefined;
  const local = (email.split("@")[0] ?? "").split("+")[0] ?? "";
  let base = local.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  if (!base) base = "user";
  const [taken] = await db.select({ id: profiles.id }).from(profiles)
    .where(and(eq(profiles.projectId, projectId), eq(profiles.username, base))).limit(1);
  if (!taken) return base;
  const suffix = (authUserId ?? "").replace(/-/g, "").slice(0, 8) || Math.random().toString(36).slice(2, 10);
  return `${base.slice(0, 27)}-${suffix}`;
}

async function ensureProfile(projectId: string, authUserId: string, attrs: { email?: string; name?: string; username?: string }): Promise<ProfileRow> {
  const existing = await profileByAuthUser(projectId, authUserId);
  if (existing) return existing;
  const username = attrs.username ?? await defaultUsername(projectId, attrs.email, authUserId);
  const [row] = await db.insert(profiles).values({
    projectId, authUserId, email: attrs.email, name: attrs.name, username,
    authMethods: ["password"],
  }).returning();
  return row!;
}

// Resolve the per-request auth bits (deployment operator + per-project role grants) for a profile.
// steward folds in admin/owner (hierarchy); owner/admin carry the raw grant for the AuthUser fields.
async function authBits(projectId: string, profile: ProfileRow) {
  const roles = await getProjectRoles(projectId, profile.id);
  const owner = roles.has("owner");
  const admin = roles.has("admin");
  return { operator: isOperator(profile), owner, admin, steward: roles.has("steward") || admin || owner };
}

// Build the auth response: AuthUser + a fresh token pair.
async function sessionResponse(projectId: string, profile: ProfileRow) {
  const [suspensions, { operator, owner, admin, steward }] = await Promise.all([
    db.select().from(userSuspensions).where(eq(userSuspensions.profileId, profile.id)),
    authBits(projectId, profile),
  ]);
  const { accessToken, refreshToken } = await mintSession(projectId, profile.id, profile.role, operator, steward, owner, admin);
  return { user: shapeAuthUser(profile, suspensions, operator, steward, owner, admin), accessToken, refreshToken };
}

export const authRoutes = new Hono<{ Variables: Variables }>()
  .post("/sign-up", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(signUpSchema, await c.req.json().catch(() => ({})), "auth");
    const check = await webhooks.validate(projectId, "user.created", { email: body.email, name: body.name, username: body.username });
    if (!check.valid) {
      logger.info({ projectId }, "auth: sign-up rejected by validation webhook");
      throw Errors.forbidden("auth/rejected", check.message ?? "Sign-up rejected by validation webhook");
    }
    const provider = await getAuthProvider(projectId);
    const result = await provider.signUp(projectId, body.email, body.password);
    if (result.status === "confirmation_required") {
      logger.info({ projectId }, "auth: sign-up pending email confirmation");
      return c.json({ status: "confirmation_required", email: body.email }, 200);
    }
    const profile = await ensureProfile(projectId, result.authUserId, { email: body.email, name: body.name, username: body.username });
    const session = await sessionResponse(projectId, profile);
    logger.info({ projectId, userId: profile.id, autoConfirmed: true }, "auth: signed up");
    webhooks.broadcast(projectId, "user.created.complete", session.user);
    return c.json(session, 201);
  })
  .post("/sign-in", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(signInSchema, await c.req.json().catch(() => ({})), "auth");
    const provider = await getAuthProvider(projectId);
    const cred = await provider.verifyCredentials(projectId, body.email, body.password);
    if (!cred) {
      logger.info({ projectId }, "auth: sign-in failed (invalid credentials)");
      throw Errors.unauthorized("auth/invalid-credentials", "Invalid email or password");
    }
    const profile = await ensureProfile(projectId, cred.authUserId, { email: body.email });
    await db.update(profiles).set({ lastActive: new Date() }).where(eq(profiles.id, profile.id));
    logger.info({ projectId, userId: profile.id, role: profile.role, operator: isOperator(profile) }, "auth: signed in");
    return c.json(await sessionResponse(projectId, profile));
  })
  // Sign-out is idempotent and must NOT require a valid access token: a stale/expired access token
  // (the common case when signing out a long-idle tab) shouldn't block revoking the refresh token.
  // The SDK sends the refresh token in the body, which we can revoke without an authenticated user;
  // fall back to revoking all of the authed user's tokens when only a valid access token is present.
  .post("/sign-out", optionalAuth, async (c) => {
    const body = parseBody(signOutSchema, await c.req.json().catch(() => ({})), "auth");
    if (body.refreshToken) await revokeRefreshToken(c.var.projectId, body.refreshToken);
    else if (c.var.auth?.userId) await revokeAllForProfile(c.var.auth.userId);
    logger.info({ projectId: c.var.projectId, userId: c.var.auth?.userId ?? null, byRefreshToken: !!body.refreshToken }, "auth: signed out");
    return c.json({ success: true }); // always 200 — nothing to revoke is still a successful sign-out
  })
  .post("/request-new-access-token", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(refreshSchema, await c.req.json().catch(() => ({})), "auth");
    const { profileId, ...tokens } = await rotateRefreshToken(projectId, body.refreshToken);
    // Return the user with the rotated tokens. The SDK's refresh/session-restore path calls
    // setUser(result.user), so omitting it would wipe the current user from the store on every
    // refresh (breaking "is this my message?" checks, optimistic-message authorship, etc.).
    const [profile] = await db.select().from(profiles)
      .where(and(eq(profiles.projectId, projectId), eq(profiles.id, profileId))).limit(1);
    const suspensions = profile
      ? await db.select().from(userSuspensions).where(eq(userSuspensions.profileId, profile.id))
      : [];
    const bits = profile ? await authBits(projectId, profile) : undefined;
    return c.json({
      ...tokens,
      user: profile && bits
        ? shapeAuthUser(profile, suspensions, bits.operator, bits.steward, bits.owner, bits.admin)
        : undefined,
    });
  })
  .post("/change-password", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(changePasswordSchema, await c.req.json().catch(() => ({})), "auth");
    const [profile] = await db.select().from(profiles)
      .where(and(eq(profiles.projectId, projectId), eq(profiles.id, c.var.auth!.userId))).limit(1);
    if (!profile?.authUserId || !profile.email) throw Errors.badRequest("auth/no-password-identity", "No password identity for this user");
    const provider = await getAuthProvider(projectId);
    await provider.changePassword(profile.authUserId, profile.email, body.currentPassword, body.newPassword);
    // Invalidate all existing sessions, then hand back a fresh one.
    await revokeAllForProfile(profile.id);
    logger.info({ projectId, userId: profile.id }, "auth: password changed (all sessions revoked)");
    const b = await authBits(projectId, profile);
    return c.json({ success: true, ...(await mintSession(projectId, profile.id, profile.role, b.operator, b.steward, b.owner, b.admin)) });
  })
  .post("/request-password-reset", async (c) => {
    const body = parseBody(emailSchema, await c.req.json().catch(() => ({})), "auth");
    const provider = await getAuthProvider(c.var.projectId);
    await provider.startPasswordReset(c.var.projectId, body.email);
    return c.json({ success: true });
  })
  .post("/reset-password", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(resetPasswordSchema, await c.req.json().catch(() => ({})), "auth");
    const provider = await getAuthProvider(projectId);
    const { authUserId } = await provider.confirmPasswordReset(projectId, body.token, body.newPassword);
    const [profile] = await db.select({ id: profiles.id }).from(profiles)
      .where(and(eq(profiles.projectId, projectId), eq(profiles.authUserId, authUserId))).limit(1);
    if (profile) await revokeAllForProfile(profile.id);
    logger.info({ projectId }, "auth: password reset completed");
    return c.json({ success: true });
  })
  .post("/verify-email", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(verifyEmailSchema, await c.req.json().catch(() => ({})), "auth");
    const provider = await getAuthProvider(projectId);
    const { authUserId } = await provider.confirmEmail(projectId, body.tokenHash, body.type);
    await db.update(profiles).set({ isVerified: true }).where(and(eq(profiles.projectId, projectId), eq(profiles.authUserId, authUserId)));
    logger.info({ projectId }, "auth: email verified");
    return c.json({ success: true });
  })
  .post("/send-verification-email", async (c) => {
    const body = parseBody(emailSchema, await c.req.json().catch(() => ({})), "auth");
    const provider = await getAuthProvider(c.var.projectId);
    await provider.resendConfirmation(c.var.projectId, body.email);
    return c.json({ success: true });
  })
  // Self-service account deletion (SDK useRequestAccountDeletion / confirmAccountDeletion). Step 1
  // emails a confirmation code (profile-keyed → works for native AND Supabase users); step 2 verifies
  // it and applies the project's deletion mode (hard | soft | ban). On HARD, the profile is removed and
  // authored content survives as authorless (set-null) — community property, not erased with the author.
  // On SOFT/BAN the profile is retained but deactivated and the auth identity is disabled.
  .post("/request-account-deletion", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const [profile] = await db.select().from(profiles)
      .where(and(eq(profiles.projectId, projectId), eq(profiles.id, c.var.auth!.userId))).limit(1);
    if (!profile?.email) throw Errors.badRequest("auth/no-email", "No email on file for this account");
    await requestAccountDeletion(projectId, profile.id, profile.email);
    logger.info({ projectId, userId: profile.id }, "auth: account-deletion requested");
    return c.json({ success: true });
  })
  .post("/confirm-account-deletion", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(confirmAccountDeletionSchema, await c.req.json().catch(() => ({})), "auth");
    const [profile] = await db.select().from(profiles)
      .where(and(eq(profiles.projectId, projectId), eq(profiles.id, c.var.auth!.userId))).limit(1);
    if (!profile) throw Errors.unauthorized("auth/no-profile", "Authenticated user has no profile");
    await verifyAccountDeletionCode(projectId, profile.id, body.code);
    const [proj] = await db.select({ mode: projects.accountDeletionMode }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const mode = resolveDeletionMode(proj?.mode);
    const provider = await getAuthProvider(projectId);
    if (profile.authUserId) await provider.deleteUser(profile.authUserId, mode);
    await revokeAllForProfile(profile.id); // kill sessions in every mode
    if (mode === "hard") {
      // FK onDelete on profiles.id: content (entities/comments) → set null (authorless, preserved);
      // engagement (reactions/follows/connections/memberships) → cascade.
      await db.delete(profiles).where(and(eq(profiles.projectId, projectId), eq(profiles.id, profile.id)));
    } else {
      await db.update(profiles).set({ isActive: false }).where(and(eq(profiles.projectId, projectId), eq(profiles.id, profile.id)));
    }
    logger.info({ projectId, userId: profile.id, mode }, "auth: account deleted");
    return c.json({ success: true });
  })
  .post("/verify-external-user", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(externalUserSchema, await c.req.json().catch(() => ({})), "auth");
    const [project] = await db.select({ key: projects.externalAuthPublicKey }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project?.key) throw Errors.badRequest("auth/external-not-configured", "External auth public key not set for this project");

    let payload: Record<string, any>;
    try {
      // Defense-in-depth: the key is operator-configured out-of-band, but reject a weak/wrong-type key
      // before trusting any token signed by it — a sub-2048-bit RSA (or non-RSA) key under RS256 must
      // never gate identity. createPublicKey parses the same PEM jose's importSPKI consumes.
      const details = createPublicKey(project.key);
      const modulusLength = (details.asymmetricKeyDetails?.modulusLength ?? 0);
      if (details.asymmetricKeyType !== "rsa" || modulusLength < 2048) {
        throw new Error("external auth key must be RSA ≥2048-bit");
      }
      const publicKey = await importSPKI(project.key, "RS256");
      ({ payload } = await jwtVerify(body.userJwt ?? body.token!, publicKey, { algorithms: ["RS256"], audience: "replyke.com", issuer: projectId }) as any);
    } catch (e: any) {
      logger.debug({ projectId, err: e }, "auth: external token verification failed");
      throw Errors.unauthorized("auth/external-invalid", `External token invalid: ${e?.message ?? "verification failed"}`);
    }
    const foreignId = String(payload.sub ?? "");
    if (!foreignId) throw Errors.badRequest("auth/external-missing-sub", "External token missing sub claim");
    const ud = (payload.userData ?? {}) as Record<string, any>;

    // Upsert profile keyed by foreign id.
    const [existing] = await db.select().from(profiles)
      .where(and(eq(profiles.projectId, projectId), eq(profiles.foreignId, foreignId))).limit(1);
    let profile: ProfileRow;
    if (existing) {
      const [row] = await db.update(profiles).set({
        ...(ud.name !== undefined ? { name: ud.name } : {}),
        ...(ud.username !== undefined ? { username: ud.username } : {}),
        ...(ud.avatar !== undefined ? { avatar: ud.avatar } : {}),
        ...(ud.metadata !== undefined ? { metadata: ud.metadata } : {}),
      }).where(eq(profiles.id, existing.id)).returning();
      profile = row!;
    } else {
      const [row] = await db.insert(profiles).values({
        projectId, foreignId, name: ud.name, username: ud.username, avatar: ud.avatar,
        metadata: ud.metadata ?? {}, authMethods: ["external"],
      }).returning();
      profile = row!;
    }
    logger.info({ projectId, userId: profile.id, foreignId, isNew: !existing }, "auth: external user verified");
    return c.json(await sessionResponse(projectId, profile));
  });
