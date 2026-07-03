// Production EmailSender transport: Postmark (https://postmarkapp.com). Implements the same
// EmailSender interface as the dev ConsoleEmailSender, so callers (native-provider, account-deletion)
// are unchanged — resolveEmailSender() picks this when POSTMARK_SERVER_TOKEN is configured.
//
// Postmark's single-send API is a plain HTTPS POST to /email with an X-Postmark-Server-Token header,
// so no SDK dependency is needed. All addressing (from/stream/api base) comes from env (see env.ts).
//
// Security/logging: the recipient address is PII and the Postmark response body can echo it, so those
// go on `debug` ONLY (off in prod). `info`/`error` stay message-only per the Log-with-intent policy.
import { logger } from "../../logger.js";
import type { EmailSender } from "./sender.js";

export interface PostmarkConfig {
  token: string;
  from: string;
  stream: string;
  apiBase: string;
}

interface EmailBody {
  subject: string;
  html: string;
  text: string;
}

export class PostmarkEmailSender implements EmailSender {
  constructor(private readonly cfg: PostmarkConfig) {}

  async sendConfirmation(to: string, link: string): Promise<void> {
    await this.send(to, confirmationBody(link));
    logger.info("auth-email: confirmation email dispatched");
  }

  async sendPasswordReset(to: string, link: string): Promise<void> {
    await this.send(to, passwordResetBody(link));
    logger.info("auth-email: password-reset email dispatched");
  }

  async sendAccountDeletionCode(to: string, code: string): Promise<void> {
    await this.send(to, accountDeletionBody(code));
    logger.info("auth-email: account-deletion email dispatched");
  }

  private async send(to: string, body: EmailBody): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.apiBase}/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Postmark-Server-Token": this.cfg.token,
        },
        body: JSON.stringify({
          From: this.cfg.from,
          To: to,
          Subject: body.subject,
          HtmlBody: body.html,
          TextBody: body.text,
          MessageStream: this.cfg.stream,
        }),
      });
    } catch (err) {
      // Network / DNS / TLS failure reaching Postmark. Message-only at error; the exception (which can
      // carry the request context) at debug.
      logger.error("auth-email: Postmark request failed");
      logger.debug({ err }, "auth-email: Postmark request failed");
      throw new Error("Postmark request failed");
    }
    if (!res.ok) {
      // Postmark rejected the send (bad token, unverified From, inactive recipient, …). The JSON body
      // carries ErrorCode + Message and may echo the recipient — debug ONLY. Surface a message-only error.
      const detail = await res.text().catch(() => "");
      logger.error("auth-email: Postmark rejected the send");
      logger.debug({ status: res.status, detail }, "auth-email: Postmark rejected the send");
      throw new Error(`Postmark send failed (${res.status})`);
    }
  }
}

// ── Message bodies ────────────────────────────────────────────────────────────────────────────────
// Deliberately plain (no external assets — Artifacts-style CSP not relevant, but keeping them
// dependency-free and inline keeps deliverability high and the transport self-contained).
function confirmationBody(link: string): EmailBody {
  return {
    subject: "Confirm your email",
    text: `Confirm your email to finish signing up:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Confirm your email to finish signing up:</p><p><a href="${escapeAttr(link)}">Confirm my email</a></p>`
      + `<p>Or paste this link into your browser:<br>${escapeHtml(link)}</p>`
      + `<p>If you didn't request this, you can ignore this email.</p>`,
  };
}

function passwordResetBody(link: string): EmailBody {
  return {
    subject: "Reset your password",
    text: `Reset your password using the link below:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: `<p>Reset your password using the link below:</p><p><a href="${escapeAttr(link)}">Reset my password</a></p>`
      + `<p>Or paste this link into your browser:<br>${escapeHtml(link)}</p>`
      + `<p>If you didn't request this, you can ignore this email.</p>`,
  };
}

function accountDeletionBody(code: string): EmailBody {
  return {
    subject: "Confirm account deletion",
    text: `Your account-deletion confirmation code is: ${code}\n\nEnter it to confirm. If you didn't request this, change your password immediately.`,
    html: `<p>Your account-deletion confirmation code is:</p><p style="font-size:20px;font-weight:bold">${escapeHtml(code)}</p>`
      + `<p>Enter it to confirm. If you didn't request this, change your password immediately.</p>`,
  };
}

// Minimal escaping so a link/code can't break out of the HTML body. Links are server-built tokens, but
// escaping keeps the transport robust if a caller ever passes richer content.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
