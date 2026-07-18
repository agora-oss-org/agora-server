// Settings-read-only allowlist (env-configured). An account in this list gets the normal operator/admin
// view but is blocked from the five settings-SAVE endpoints (the guard is lib/project-roles.ts
// `assertSettingsWritable`). Powers the shared public-demo login: look at everything, change nothing.
//
// Matched by email only (case-insensitive) — the demo account is addressed by email. The result is
// stamped into the access JWT at mint time (lib/tokens.ts) and read back in core middleware/auth.ts,
// so handlers see `c.var.auth.settingsReadonly` with no extra DB hit. Mirrors lib/operators.ts.
import { env } from "./env.js";

const split = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const readonlyEmails = new Set(split(env.OPERATOR_RO_EMAILS).map((e) => e.toLowerCase()));

/** True when a profile's email is in the settings-read-only allowlist. */
export function isSettingsReadonly(profile: { email?: string | null }): boolean {
  const email = profile.email?.toLowerCase();
  return !!email && readonlyEmails.has(email);
}
