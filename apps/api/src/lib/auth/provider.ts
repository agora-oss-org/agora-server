// The credential boundary. Implementations verify credentials and run email flows; the
// route keeps doing profile + session work (ensureProfile, mintSession). A provider's
// `authUserId` becomes profiles.auth_user_id. Providers throw http Errors.* directly so
// the existing error envelopes are preserved (ApiError is a plain class, no Hono dep).
export type SignUpResult =
  | { status: "confirmed"; authUserId: string }
  | { status: "confirmation_required" };

export interface AuthProvider {
  /** Create an account. Returns confirmed (mint a session now) or confirmation_required (email sent). */
  signUp(projectId: string, email: string, password: string): Promise<SignUpResult>;
  /** Verify credentials for sign-in. Returns the identity or null (caller throws the generic 401). */
  verifyCredentials(projectId: string, email: string, password: string): Promise<{ authUserId: string } | null>;
  /** Change password for a known identity. Throws Errors.badRequest("auth/wrong-password") on bad current. */
  changePassword(authUserId: string, email: string | null, current: string, next: string): Promise<void>;
  /** Begin a reset (send email). Best-effort, never throws, never reveals account existence. */
  startPasswordReset(projectId: string, email: string): Promise<void>;
  /** Complete a reset with a token. Throws Errors.badRequest("auth/reset-invalid") on bad/expired/used token. */
  confirmPasswordReset(projectId: string, token: string, newPassword: string): Promise<{ authUserId: string }>;
  /** Confirm an email with a token. Throws Errors.badRequest("auth/verify-failed") on bad token. */
  confirmEmail(projectId: string, token: string, type?: string): Promise<{ authUserId: string }>;
  /** Re-send a confirmation email. Best-effort, never throws, never reveals existence/state. */
  resendConfirmation(projectId: string, email: string): Promise<void>;
}
