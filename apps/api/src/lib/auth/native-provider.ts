// Agora-owned credential store for the shared hosting tier. Per-tenant identity via
// unique(project_id, email). Email normalized to lowercase (no citext). Tokens are
// random, stored hashed, single-use, expiring. Anti-enumeration on sign-up/reset/resend.
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import { authCredentials, authEmailTokens } from "../../db/schema/index.js";
import { Errors } from "../../http/errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateEmailToken, hashEmailToken } from "./email-token.js";
import { confirmLink, resetLink, type EmailSender } from "./email/sender.js";
import type { AuthProvider, SignUpResult, AccountDeletionMode } from "./provider.js";

const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000;        // 1h

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class NativeAuthProvider implements AuthProvider {
  constructor(private readonly email: EmailSender) {}

  async signUp(projectId: string, emailRaw: string, password: string, linkBase?: string): Promise<SignUpResult> {
    const email = normalizeEmail(emailRaw);
    const [existing] = await db.select({ id: authCredentials.id }).from(authCredentials)
      .where(and(eq(authCredentials.projectId, projectId), eq(authCredentials.email, email))).limit(1);
    if (existing) {
      // Anti-enumeration: don't reveal, don't recreate. Run a throwaway hash so the existing-email
      // path takes ~the same time as the new-account path below (no argon2 timing oracle).
      await hashPassword(password);
      return { status: "confirmation_required" };
    }
    const passwordHash = await hashPassword(password);
    const [cred] = await db.insert(authCredentials).values({ projectId, email, passwordHash }).returning({ id: authCredentials.id });
    await this.sendConfirm(projectId, cred!.id, email, linkBase);
    return { status: "confirmation_required" };
  }

  async verifyCredentials(projectId: string, emailRaw: string, password: string) {
    const email = normalizeEmail(emailRaw);
    const [cred] = await db.select().from(authCredentials)
      .where(and(eq(authCredentials.projectId, projectId), eq(authCredentials.email, email))).limit(1);
    if (!cred || !cred.emailConfirmedAt || cred.disabledAt) return null; // unknown / unconfirmed / disabled
    return (await verifyPassword(cred.passwordHash, password)) ? { authUserId: cred.id } : null;
  }

  async changePassword(authUserId: string, _email: string | null, current: string, next: string): Promise<void> {
    const [cred] = await db.select().from(authCredentials).where(eq(authCredentials.id, authUserId)).limit(1);
    if (!cred) throw Errors.badRequest("auth/no-password-identity", "No password identity for this user");
    if (!(await verifyPassword(cred.passwordHash, current))) {
      throw Errors.badRequest("auth/wrong-password", "Current password is incorrect", "currentPassword");
    }
    await db.update(authCredentials).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(authCredentials.id, authUserId));
  }

  async startPasswordReset(projectId: string, emailRaw: string, linkBase?: string): Promise<void> {
    const email = normalizeEmail(emailRaw);
    const [cred] = await db.select({ id: authCredentials.id }).from(authCredentials)
      .where(and(eq(authCredentials.projectId, projectId), eq(authCredentials.email, email))).limit(1);
    if (!cred) return; // silent — anti-enumeration
    // Invalidate any prior pending reset tokens for this credential (token hygiene; single
    // active reset link at a time without a DB constraint that could lock out re-requests).
    await db.delete(authEmailTokens)
      .where(and(eq(authEmailTokens.credentialId, cred.id), eq(authEmailTokens.kind, "reset"), isNull(authEmailTokens.consumedAt)));
    const { raw, hash } = generateEmailToken();
    await db.insert(authEmailTokens).values({ credentialId: cred.id, kind: "reset", tokenHash: hash, expiresAt: new Date(Date.now() + RESET_TTL_MS) });
    await this.email.sendPasswordReset(email, resetLink(projectId, raw, linkBase));
  }

  async confirmPasswordReset(projectId: string, token: string, newPassword: string) {
    const row = await this.consumeToken(projectId, token, "reset");
    if (!row) throw Errors.badRequest("auth/reset-invalid", "Reset link is invalid or expired");
    await db.update(authCredentials).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(authCredentials.id, row.credentialId));
    return { authUserId: row.credentialId };
  }

  async confirmEmail(projectId: string, token: string, _type?: string) {
    const row = await this.consumeToken(projectId, token, "confirm");
    if (!row) throw Errors.badRequest("auth/verify-failed", "Verification link is invalid or expired");
    await db.update(authCredentials).set({ emailConfirmedAt: new Date(), updatedAt: new Date() }).where(eq(authCredentials.id, row.credentialId));
    return { authUserId: row.credentialId };
  }

  async resendConfirmation(projectId: string, emailRaw: string, linkBase?: string): Promise<void> {
    const email = normalizeEmail(emailRaw);
    const [cred] = await db.select().from(authCredentials)
      .where(and(eq(authCredentials.projectId, projectId), eq(authCredentials.email, email))).limit(1);
    if (!cred || cred.emailConfirmedAt) return; // nothing to do / already confirmed — silent
    await this.sendConfirm(projectId, cred.id, email, linkBase);
  }

  async deleteUser(authUserId: string, mode: AccountDeletionMode): Promise<void> {
    if (mode === "hard") {
      await db.delete(authCredentials).where(eq(authCredentials.id, authUserId)); // tokens cascade away
      return;
    }
    // soft / ban — disable the credential so it can never sign in (verifyCredentials rejects disabled).
    await db.update(authCredentials).set({ disabledAt: new Date(), updatedAt: new Date() })
      .where(eq(authCredentials.id, authUserId));
  }

  private async sendConfirm(projectId: string, credentialId: string, email: string, linkBase?: string): Promise<void> {
    // Invalidate prior pending confirm tokens before issuing a fresh one (token hygiene).
    await db.delete(authEmailTokens)
      .where(and(eq(authEmailTokens.credentialId, credentialId), eq(authEmailTokens.kind, "confirm"), isNull(authEmailTokens.consumedAt)));
    const { raw, hash } = generateEmailToken();
    await db.insert(authEmailTokens).values({ credentialId, kind: "confirm", tokenHash: hash, expiresAt: new Date(Date.now() + CONFIRM_TTL_MS) });
    await this.email.sendConfirmation(email, confirmLink(projectId, raw, linkBase));
  }

  // Hash the presented token, find a live token of the right kind whose credential is in
  // THIS project (tenant isolation), then atomically mark it consumed (single-use; the
  // conditional update guards a redelivery/replay race).
  private async consumeToken(projectId: string, raw: string, kind: "confirm" | "reset") {
    const tokenHash = hashEmailToken(raw);
    const [row] = await db.select({ id: authEmailTokens.id, credentialId: authEmailTokens.credentialId })
      .from(authEmailTokens)
      .innerJoin(authCredentials, eq(authEmailTokens.credentialId, authCredentials.id))
      .where(and(
        eq(authEmailTokens.tokenHash, tokenHash),
        eq(authEmailTokens.kind, kind),
        isNull(authEmailTokens.consumedAt),
        gt(authEmailTokens.expiresAt, new Date()),
        eq(authCredentials.projectId, projectId),
      )).limit(1);
    if (!row) return null;
    const updated = await db.update(authEmailTokens).set({ consumedAt: new Date() })
      .where(and(eq(authEmailTokens.id, row.id), isNull(authEmailTokens.consumedAt)))
      .returning({ id: authEmailTokens.id });
    return updated.length ? row : null; // lost the single-use race
  }
}
