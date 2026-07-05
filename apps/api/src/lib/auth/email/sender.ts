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
// `base` is the resolved, already-allowlist-validated front-end origin (see resolveEmailLinkBase). When
// omitted it falls back to the deployment default — the single-front-end / feature-off path.
export function confirmLink(projectId: string, rawToken: string, base: string = linkBase()): string {
  return `${base}/auth/verify-email?projectId=${projectId}&token=${encodeURIComponent(rawToken)}`;
}
export function resetLink(projectId: string, rawToken: string, base: string = linkBase()): string {
  return `${base}/auth/reset-password?projectId=${projectId}&token=${encodeURIComponent(rawToken)}`;
}

/** Canonical origin (`scheme://host[:port]`, lowercased) of a URL/base string, or "" if unparseable. */
export function normalizeOrigin(input: string): string {
  try {
    return new URL(input.trim()).origin.toLowerCase();
  } catch {
    return "";
  }
}

let _allowCache: Set<string> | null = null;
/** The configured allowlist of front-end origins (normalized). Empty ⇒ per-origin selection is off. */
export function allowedEmailOrigins(): Set<string> {
  if (_allowCache) return _allowCache;
  _allowCache = new Set(
    (env.AUTH_EMAIL_LINK_ALLOWED_ORIGINS ?? "").split(",").map(normalizeOrigin).filter(Boolean),
  );
  return _allowCache;
}

/** Pure link-base selector (extracted for testability). Security core of native-auth emailed links (only
 *  native builds server-side links — Supabase brokers its own). A configured allowlist is REQUIRED to send
 *  native-auth email: without it we can't validate the front-end origin, so we fail CLOSED rather than
 *  emailing a link built from an unvalidated client value (open-redirect / phishing) or silently falling
 *  back to a base that may be the wrong front-end. Cases:
 *  - allowlist empty        → null  (misconfiguration — caller 503s + warns; NEVER falls back)
 *  - requested absent       → default base (canonical single front-end within a configured allowlist)
 *  - requested ∈ allowlist  → that origin
 *  - requested ∉ allowlist  → null  (caller MUST reject with 400 — do not fall back to it) */
export function selectEmailLinkBase(
  requested: string | null | undefined,
  allowlist: Set<string>,
  defaultBase: string,
): string | null {
  if (allowlist.size === 0) return null; // native email requires a configured allowlist — fail closed
  if (!requested) return defaultBase;
  const origin = normalizeOrigin(requested);
  return origin && allowlist.has(origin) ? origin : null;
}

/** Resolve the emailed-link base for a request's `emailRedirectTo`. Returns null when the client sent a
 *  non-allowlisted origin (route returns 400). Reads the live env allowlist + default. */
export function resolveEmailLinkBase(requested: string | null | undefined): string | null {
  return selectEmailLinkBase(requested, allowedEmailOrigins(), env.AUTH_EMAIL_LINK_BASE);
}
