import { getSupabase, getSupabaseAnon } from "../supabase.js";
import { logger } from "../logger.js";
import { Errors } from "../../http/errors.js";
import type { AuthProvider, SignUpResult } from "./provider.js";

export class SupabaseAuthProvider implements AuthProvider {
  async signUp(_projectId: string, email: string, password: string): Promise<SignUpResult> {
    const { data, error } = await getSupabaseAnon().auth.signUp({ email, password });
    if (error) throw Errors.badRequest("auth/sign-up-failed", error.message);
    if (!data.session) return { status: "confirmation_required" }; // GoTrue: email-confirmation enabled
    return { status: "confirmed", authUserId: data.session.user.id };
  }
  async verifyCredentials(_projectId: string, email: string, password: string) {
    const { data, error } = await getSupabaseAnon().auth.signInWithPassword({ email, password });
    if (error || !data.user) return null;
    return { authUserId: data.user.id };
  }
  async changePassword(authUserId: string, email: string | null, current: string, next: string): Promise<void> {
    if (!email) throw Errors.badRequest("auth/no-password-identity", "No password identity for this user");
    const { error: badPw } = await getSupabaseAnon().auth.signInWithPassword({ email, password: current });
    if (badPw) throw Errors.badRequest("auth/wrong-password", "Current password is incorrect", "currentPassword");
    const { error } = await getSupabase().auth.admin.updateUserById(authUserId, { password: next });
    if (error) throw Errors.badRequest("auth/change-password-failed", error.message);
  }
  async startPasswordReset(_projectId: string, email: string): Promise<void> {
    await getSupabaseAnon().auth.resetPasswordForEmail(email).catch((err) => {
      logger.debug({ err }, "resetPasswordForEmail failed (best-effort)");
    });
  }
  async confirmPasswordReset(_projectId: string, token: string, newPassword: string) {
    const { data, error } = await getSupabaseAnon().auth.verifyOtp({ token_hash: token, type: "recovery" });
    if (error || !data.user) throw Errors.badRequest("auth/reset-invalid", "Reset link is invalid or expired");
    const { error: upd } = await getSupabase().auth.admin.updateUserById(data.user.id, { password: newPassword });
    if (upd) throw Errors.badRequest("auth/reset-failed", upd.message);
    return { authUserId: data.user.id };
  }
  async confirmEmail(_projectId: string, token: string, type?: string) {
    const { data, error } = await getSupabaseAnon().auth.verifyOtp({ token_hash: token, type: (type ?? "email") as any });
    if (error || !data.user) throw Errors.badRequest("auth/verify-failed", error?.message ?? "Verification failed");
    return { authUserId: data.user.id };
  }
  async resendConfirmation(_projectId: string, email: string): Promise<void> {
    await getSupabaseAnon().auth.resend({ type: "signup", email }).catch((err) => {
      logger.debug({ err }, "resend confirmation failed (best-effort)");
    });
  }
}
