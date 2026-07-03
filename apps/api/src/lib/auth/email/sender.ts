// Pluggable transport for native-auth confirmation / reset emails. Ships a dev console impl and a
// production Postmark transport (postmark.ts) selected via env — no caller change. A module-level
// override provides a test seam so the integration suite can capture the raw token (which never
// appears in logs at info).
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { PostmarkEmailSender } from "./postmark.js";

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

/** Pure selector (extracted for testability): a test override wins; else Postmark when a server token
 *  is configured; else the dev console stub that only LOGS the link. */
export function selectEmailSender(
  postmark: { token?: string; from: string; stream: string; apiBase: string },
  override: EmailSender | null,
): EmailSender {
  if (override) return override;
  if (postmark.token) {
    return new PostmarkEmailSender({
      token: postmark.token,
      from: postmark.from,
      stream: postmark.stream,
      apiBase: postmark.apiBase,
    });
  }
  return new ConsoleEmailSender();
}

export function resolveEmailSender(): EmailSender {
  return selectEmailSender(
    {
      token: env.POSTMARK_SERVER_TOKEN,
      from: env.AUTH_EMAIL_FROM,
      stream: env.POSTMARK_MESSAGE_STREAM,
      apiBase: env.POSTMARK_API_BASE,
    },
    _override,
  );
}

function linkBase(): string {
  return env.AUTH_EMAIL_LINK_BASE;
}
export function confirmLink(projectId: string, rawToken: string): string {
  return `${linkBase()}/auth/verify-email?projectId=${projectId}&token=${encodeURIComponent(rawToken)}`;
}
export function resetLink(projectId: string, rawToken: string): string {
  return `${linkBase()}/auth/reset-password?projectId=${projectId}&token=${encodeURIComponent(rawToken)}`;
}
