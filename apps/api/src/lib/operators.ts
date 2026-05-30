// Deployment-operator allowlist (env-configured). An operator is a self-hosted admin granted a
// project-wide god-view in the admin app — independent of any space role. Matched by profile UUID
// (OPERATOR_USER_IDS) or email (OPERATOR_EMAILS), both comma-separated. Emails are case-insensitive.
//
// The result is stamped into the access JWT at mint time (lib/tokens.ts) and read back in
// middleware/auth.ts, so request handlers get `c.var.auth.isOperator` with no extra DB hit.
import { env } from "./env.js";

const split = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const operatorIds = new Set(split(env.OPERATOR_USER_IDS));
const operatorEmails = new Set(split(env.OPERATOR_EMAILS).map((e) => e.toLowerCase()));

/** True when a profile (by id or email) is in the deployment-operator allowlist. */
export function isOperator(profile: { id: string; email?: string | null }): boolean {
  if (operatorIds.has(profile.id)) return true;
  const email = profile.email?.toLowerCase();
  return !!email && operatorEmails.has(email);
}
