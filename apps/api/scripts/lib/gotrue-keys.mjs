// Self-host GoTrue key material. GoTrue authenticates callers by verifying an HS256 JWT against
// GOTRUE_JWT_SECRET and reading its `role` claim — the "anon key" / "service_role key" of a cloud
// Supabase project are exactly these two long-lived JWTs. Deterministic given (secret, now) so it
// is unit-testable; the CLI supplies real randomness + wall clock.
import { SignJWT } from "jose";

const TEN_YEARS_S = 10 * 365 * 24 * 3600;

export async function buildGotrueKeys({ secret, now }) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("GOTRUE_JWT_SECRET must be at least 32 characters");
  }
  const key = new TextEncoder().encode(secret);
  const sign = (role) =>
    new SignJWT({ role, iss: "supabase" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(now + TEN_YEARS_S)
      .sign(key);
  return { anonKey: await sign("anon"), serviceKey: await sign("service_role") };
}
