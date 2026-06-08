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
import { getSupabase, getSupabaseAnon } from "../lib/supabase.js";
import { mintSession, rotateRefreshToken, revokeRefreshToken, revokeAllForProfile } from "../lib/tokens.js";
import { isOperator } from "../lib/operators.js";
import { isSteward } from "../lib/stewards.js";
import { shapeAuthUser } from "../lib/shape.js";
import { logger } from "../lib/logger.js";
import * as webhooks from "../lib/webhooks.js";
import { trackEvent } from "../lib/umami.js";
import {
  parseBody, signUpSchema, signInSchema, refreshSchema, signOutSchema,
  changePasswordSchema, emailSchema, verifyEmailSchema, externalUserSchema,
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

// Build the auth response: AuthUser + a fresh token pair.
async function sessionResponse(projectId: string, profile: ProfileRow) {
  const [suspensions, operator, steward] = await Promise.all([
    db.select().from(userSuspensions).where(eq(userSuspensions.profileId, profile.id)),
    Promise.resolve(isOperator(profile)),
    isSteward(projectId, profile.id),
  ]);
  const { accessToken, refreshToken } = await mintSession(projectId, profile.id, profile.role, operator, steward);
  return { user: shapeAuthUser(profile, suspensions, operator, steward), accessToken, refreshToken };
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
    const { data, error } = await getSupabaseAnon().auth.signUp({ email: body.email, password: body.password });
    if (error) {
      logger.warn({ projectId, err: error.message }, "auth: sign-up failed");
      throw Errors.badRequest("auth/sign-up-failed", error.message);
    }
    // When email confirmation is enabled, GoTrue creates the user and sends the confirmation
    // email but returns NO session (and supabase-js's _sessionResponse nulls out `data.user`,
    // since GoTrue serializes the new user at the top level rather than under `data.user`).
    // That is a *success*, not a failure: the user must click the email link, then sign in.
    // Don't mint Agora tokens here — the profile is created lazily on first sign-in. Returning
    // the same shape for "already registered" (GoTrue obfuscates it as no-session) also avoids
    // email enumeration.
    if (!data.session) {
      logger.info({ projectId }, "auth: sign-up pending email confirmation");
      return c.json({ status: "confirmation_required", email: body.email }, 200);
    }
    // Email confirmation is disabled (auto-confirm): a full session comes back immediately.
    const profile = await ensureProfile(projectId, data.session.user.id, { email: body.email, name: body.name, username: body.username });
    const session = await sessionResponse(projectId, profile);
    logger.info({ projectId, userId: profile.id, autoConfirmed: true }, "auth: signed up");
    webhooks.broadcast(projectId, "user.created.complete", session.user);
    trackEvent("user-signup", { projectId });
    return c.json(session, 201);
  })
  .post("/sign-in", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(signInSchema, await c.req.json().catch(() => ({})), "auth");
    const { data, error } = await getSupabaseAnon().auth.signInWithPassword({ email: body.email, password: body.password });
    if (error || !data.user) {
      logger.info({ projectId }, "auth: sign-in failed (invalid credentials)");
      throw Errors.unauthorized("auth/invalid-credentials", "Invalid email or password");
    }
    const profile = await ensureProfile(projectId, data.user.id, { email: body.email });
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
    const steward = profile ? await isSteward(projectId, profile.id) : false;
    return c.json({ ...tokens, user: profile ? shapeAuthUser(profile, suspensions, isOperator(profile), steward) : undefined });
  })
  .post("/change-password", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(changePasswordSchema, await c.req.json().catch(() => ({})), "auth");
    const [profile] = await db.select().from(profiles)
      .where(and(eq(profiles.projectId, projectId), eq(profiles.id, c.var.auth!.userId))).limit(1);
    if (!profile?.authUserId || !profile.email) throw Errors.badRequest("auth/no-password-identity", "No password identity for this user");
    // Verify current password by attempting a sign-in.
    const { error: badPw } = await getSupabaseAnon().auth.signInWithPassword({ email: profile.email, password: body.currentPassword });
    if (badPw) throw Errors.badRequest("auth/wrong-password", "Current password is incorrect", "currentPassword");
    const { error } = await getSupabase().auth.admin.updateUserById(profile.authUserId, { password: body.newPassword });
    if (error) throw Errors.badRequest("auth/change-password-failed", error.message);
    // Invalidate all existing sessions, then hand back a fresh one.
    await revokeAllForProfile(profile.id);
    logger.info({ projectId, userId: profile.id }, "auth: password changed (all sessions revoked)");
    return c.json({ success: true, ...(await mintSession(projectId, profile.id, profile.role, isOperator(profile), await isSteward(projectId, profile.id))) });
  })
  .post("/request-password-reset", async (c) => {
    const body = parseBody(emailSchema, await c.req.json().catch(() => ({})), "auth");
    // Always 200 (avoid email enumeration). Supabase sends the reset email.
    await getSupabaseAnon().auth.resetPasswordForEmail(body.email).catch(() => {});
    return c.json({ success: true });
  })
  .post("/verify-email", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(verifyEmailSchema, await c.req.json().catch(() => ({})), "auth");
    const { data, error } = await getSupabaseAnon().auth.verifyOtp({ token_hash: body.tokenHash, type: body.type ?? "email" });
    if (error || !data.user) throw Errors.badRequest("auth/verify-failed", error?.message ?? "Verification failed");
    await db.update(profiles).set({ isVerified: true })
      .where(and(eq(profiles.projectId, projectId), eq(profiles.authUserId, data.user.id)));
    logger.info({ projectId }, "auth: email verified");
    return c.json({ success: true });
  })
  .post("/send-verification-email", async (c) => {
    const body = parseBody(emailSchema, await c.req.json().catch(() => ({})), "auth");
    await getSupabaseAnon().auth.resend({ type: "signup", email: body.email }).catch(() => {});
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
      logger.info({ projectId, err: e?.message }, "auth: external token verification failed");
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
