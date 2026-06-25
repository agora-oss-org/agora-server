// Self-service account-deletion confirmation codes — PROFILE-keyed, so the flow works for any auth
// provider (native or Supabase). Mirrors the native email-token hygiene: single active code, hashed
// at rest, single-use, expiring. The identity deletion itself is the provider's job (deleteUser).
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { accountDeletionCodes } from "../db/schema/index.js";
import { Errors } from "../http/errors.js";
import { generateEmailToken, hashEmailToken } from "./auth/email-token.js";
import { resolveEmailSender } from "./auth/email/sender.js";

const DELETE_TTL_MS = 60 * 60 * 1000; // 1h

/** Issue + email a fresh deletion code, invalidating any prior pending code for this profile. */
export async function requestAccountDeletion(projectId: string, profileId: string, email: string): Promise<void> {
  await db.delete(accountDeletionCodes)
    .where(and(eq(accountDeletionCodes.profileId, profileId), isNull(accountDeletionCodes.consumedAt)));
  const { raw, hash } = generateEmailToken();
  await db.insert(accountDeletionCodes).values({
    projectId, profileId, codeHash: hash, expiresAt: new Date(Date.now() + DELETE_TTL_MS),
  });
  await resolveEmailSender().sendAccountDeletionCode(email, raw);
}

/** Verify + atomically consume a deletion code. Throws Errors.badRequest on bad/expired/used. */
export async function verifyAccountDeletionCode(projectId: string, profileId: string, code: string): Promise<void> {
  const codeHash = hashEmailToken(code);
  const [row] = await db.select({ id: accountDeletionCodes.id }).from(accountDeletionCodes).where(and(
    eq(accountDeletionCodes.projectId, projectId),
    eq(accountDeletionCodes.profileId, profileId),
    eq(accountDeletionCodes.codeHash, codeHash),
    isNull(accountDeletionCodes.consumedAt),
    gt(accountDeletionCodes.expiresAt, new Date()),
  )).limit(1);
  if (!row) throw Errors.badRequest("auth/deletion-invalid", "Deletion code is invalid or expired", "code");
  const consumed = await db.update(accountDeletionCodes).set({ consumedAt: new Date() })
    .where(and(eq(accountDeletionCodes.id, row.id), isNull(accountDeletionCodes.consumedAt)))
    .returning({ id: accountDeletionCodes.id });
  if (!consumed.length) throw Errors.badRequest("auth/deletion-invalid", "Deletion code is invalid or expired", "code");
}

/** Resolve a project's configured deletion mode, defaulting to "hard" for any unexpected value. */
export function resolveDeletionMode(raw: string | null | undefined): "hard" | "soft" | "ban" {
  return raw === "soft" || raw === "ban" ? raw : "hard";
}
