// Pluggable transport for native-auth confirmation / reset emails. Ships a dev console
// impl; the production transport (Resend/SES/Postmark) is a later impl behind this
// interface — no caller change. A module-level override provides a test seam so the
// integration suite can capture the raw token (which never appears in logs at info).
import { logger } from "../../logger.js";

export interface EmailSender {
  sendConfirmation(to: string, link: string): Promise<void>;
  sendPasswordReset(to: string, link: string): Promise<void>;
  /** A short-lived code the user re-enters to confirm self-service account deletion. */
  sendAccountDeletionCode(to: string, code: string): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  async sendConfirmation(to: string, link: string): Promise<void> {
    logger.debug({ to, link }, "auth-email: confirmation link");
    logger.info("auth-email: confirmation email dispatched");
  }
  async sendPasswordReset(to: string, link: string): Promise<void> {
    logger.debug({ to, link }, "auth-email: password-reset link");
    logger.info("auth-email: password-reset email dispatched");
  }
  async sendAccountDeletionCode(to: string, code: string): Promise<void> {
    logger.debug({ to, code }, "auth-email: account-deletion code");
    logger.info("auth-email: account-deletion email dispatched");
  }
}

let _override: EmailSender | null = null;
/** Test seam: override the active sender (pass null to reset). */
export function setEmailSender(sender: EmailSender | null): void {
  _override = sender;
}
export function resolveEmailSender(): EmailSender {
  return _override ?? new ConsoleEmailSender();
}

function linkBase(): string {
  return process.env.AUTH_EMAIL_LINK_BASE || "http://localhost:5173";
}
export function confirmLink(projectId: string, rawToken: string): string {
  return `${linkBase()}/auth/verify-email?projectId=${projectId}&token=${encodeURIComponent(rawToken)}`;
}
export function resetLink(projectId: string, rawToken: string): string {
  return `${linkBase()}/auth/reset-password?projectId=${projectId}&token=${encodeURIComponent(rawToken)}`;
}
