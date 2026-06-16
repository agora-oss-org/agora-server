// Confirmation / password-reset tokens for native auth. The raw token only ever leaves
// the server in an email; the DB stores only its sha256 hash (single-use, expiring).
import { randomBytes, createHash } from "node:crypto";

export function hashEmailToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateEmailToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashEmailToken(raw) };
}
