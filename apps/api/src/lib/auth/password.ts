// Argon2id password hashing for the native auth provider. Thin wrappers over the
// vetted @node-rs/argon2 lib (no hand-rolled crypto) — hash() defaults to argon2id and
// emits a self-describing PHC string; verify() is constant-time.
import { hash, verify } from "@node-rs/argon2";

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

// Arg order is (hashed, plain) — hash first, matching @node-rs/argon2's verify().
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false; // malformed/empty hash → treat as non-match, never throw
  }
}
