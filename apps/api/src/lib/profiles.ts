// Shared profile-creation helpers used by every "new auth user → new profiles row" path (native/Supabase
// password auth in routes/auth.ts, OAuth in routes/misc.ts) so a default username is derived consistently
// regardless of which identity provider created the account.
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { profiles } from "../db/schema/index.js";

// Pure: derive a sanitized username base from an email local-part. `user@x.com` → `user`; the `+tag`
// suffix is dropped; anything outside [a-z0-9_-] is stripped; empty/all-stripped falls back to "user".
export function sanitizeUsernameBase(email?: string): string | undefined {
  if (!email) return undefined;
  const local = (email.split("@")[0] ?? "").split("+")[0] ?? "";
  const base = local.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return base || "user";
}

// Derive a default username from an email local-part so new accounts aren't nameless (the SDK/UI falls
// back to a raw id slice otherwise). The `(project_id, username)` unique constraint means we must avoid
// collisions: if the base is taken, suffix with the auth user's id prefix (unique per user) → no insert
// failure.
export async function defaultUsername(projectId: string, email?: string, authUserId?: string): Promise<string | undefined> {
  const base = sanitizeUsernameBase(email);
  if (!base) return undefined;
  const [taken] = await getDb().select({ id: profiles.id }).from(profiles)
    .where(and(eq(profiles.projectId, projectId), eq(profiles.username, base))).limit(1);
  if (!taken) return base;
  const suffix = (authUserId ?? "").replace(/-/g, "").slice(0, 8) || Math.random().toString(36).slice(2, 10);
  return `${base.slice(0, 27)}-${suffix}`;
}
