// /v7/:projectId/auth/*
// Identity is backed by Supabase Auth (passwords + confirmation/reset emails); Agora mints its
// own access/refresh tokens on top (lib/tokens.ts) and keeps a `profiles` row per auth user.
// verify-external-user bypasses Supabase: RS256 verify against the project's public key.
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { importSPKI, jwtVerify } from "jose";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { profiles, userSuspensions, projects } from "../db/schema/index.js";
import { getSupabase, getSupabaseAnon } from "../lib/supabase.js";
import { mintSession, rotateRefreshToken, revokeRefreshToken, revokeAllForProfile } from "../lib/tokens.js";
import { shapeAuthUser } from "../lib/shape.js";
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
async function ensureProfile(projectId: string, authUserId: string, attrs: { email?: string; name?: string; username?: string }): Promise<ProfileRow> {
  const existing = await profileByAuthUser(projectId, authUserId);
  if (existing) return existing;
  const [row] = await db.insert(profiles).values({
    projectId, authUserId, email: attrs.email, name: attrs.name, username: attrs.username,
    authMethods: ["password"],
  }).returning();
  return row!;
}

// Build the auth response: AuthUser + a fresh token pair.
async function sessionResponse(projectId: string, profile: ProfileRow) {
  const suspensions = await db.select().from(userSuspensions).where(eq(userSuspensions.profileId, profile.id));
  const { accessToken, refreshToken } = await mintSession(projectId, profile.id, profile.role);
  return { user: shapeAuthUser(profile, suspensions), accessToken, refreshToken };
}

export const authRoutes = new Hono<{ Variables: Variables }>()
  .post("/sign-up", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(signUpSchema, await c.req.json().catch(() => ({})), "auth");
    const { data, error } = await getSupabaseAnon().auth.signUp({ email: body.email, password: body.password });
    if (error || !data.user) throw Errors.badRequest("auth/sign-up-failed", error?.message ?? "Sign up failed");
    const profile = await ensureProfile(projectId, data.user.id, { email: body.email, name: body.name, username: body.username });
    return c.json(await sessionResponse(projectId, profile), 201);
  })
  .post("/sign-in", async (c) => {
    const projectId = c.var.projectId;
    const body = parseBody(signInSchema, await c.req.json().catch(() => ({})), "auth");
    const { data, error } = await getSupabaseAnon().auth.signInWithPassword({ email: body.email, password: body.password });
    if (error || !data.user) throw Errors.unauthorized("auth/invalid-credentials", "Invalid email or password");
    const profile = await ensureProfile(projectId, data.user.id, { email: body.email });
    await db.update(profiles).set({ lastActive: new Date() }).where(eq(profiles.id, profile.id));
    return c.json(await sessionResponse(projectId, profile));
  })
  .post("/sign-out", requireAuth, async (c) => {
    const body = parseBody(signOutSchema, await c.req.json().catch(() => ({})), "auth");
    if (body.refreshToken) await revokeRefreshToken(c.var.projectId, body.refreshToken);
    else await revokeAllForProfile(c.var.auth!.userId);
    return c.json({ success: true });
  })
  .post("/request-new-access-token", async (c) => {
    const body = parseBody(refreshSchema, await c.req.json().catch(() => ({})), "auth");
    const tokens = await rotateRefreshToken(c.var.projectId, body.refreshToken);
    return c.json(tokens);
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
    return c.json({ success: true, ...(await mintSession(projectId, profile.id, profile.role)) });
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
      const publicKey = await importSPKI(project.key, "RS256");
      ({ payload } = await jwtVerify(body.userJwt ?? body.token!, publicKey, { audience: "replyke.com", issuer: projectId }) as any);
    } catch (e: any) {
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
    return c.json(await sessionResponse(projectId, profile));
  });
