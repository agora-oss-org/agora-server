// Sign in with Apple: the "client secret" is itself a short-lived ES256 JWT signed with the
// developer's .p8 key. Apple caps its lifetime at 6 months (180 days) — regeneration is a
// recurring operational task (documented in docs/SELF-HOSTING.md). Pure claim-building here;
// the CLI does the key handling + signing.
export function buildAppleClaims({ teamId, clientId, keyId, now, days = 180 }) {
  for (const [name, v] of [["teamId", teamId], ["clientId", clientId], ["keyId", keyId]]) {
    if (typeof v !== "string" || v.length === 0) throw new Error(`${name} is required`);
  }
  if (!Number.isInteger(days) || days < 1 || days > 180) {
    throw new Error("days must be 1-180 (Apple caps client-secret lifetime at 180 days)");
  }
  return {
    header: { alg: "ES256", kid: keyId, typ: "JWT" },
    payload: { iss: teamId, sub: clientId, aud: "https://appleid.apple.com", iat: now, exp: now + days * 86400 },
  };
}
