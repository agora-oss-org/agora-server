#!/usr/bin/env node
// Generate the Sign in with Apple client secret (an ES256 JWT) for GOTRUE_EXTERNAL_APPLE_SECRET.
//   node scripts/gen-apple-client-secret.mjs --key ./AuthKey_KEY1234567.p8 \
//     --team-id TEAM123456 --client-id org.example.agora.web --key-id KEY1234567 [--days 180]
// The secret EXPIRES (≤180 days) — rerun before expiry and update the env (see docs/SELF-HOSTING.md).
import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";
import { buildAppleClaims } from "./lib/apple-secret.mjs";

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) { console.error(`Missing --${name}`); process.exit(1); }
    return undefined;
  }
  return process.argv[i + 1];
}

const keyPath = arg("key");
const days = arg("days", false);
const { header, payload } = buildAppleClaims({
  teamId: arg("team-id"),
  clientId: arg("client-id"),
  keyId: arg("key-id"),
  now: Math.floor(Date.now() / 1000),
  ...(days ? { days: Number(days) } : {}),
});

const pk = await importPKCS8(readFileSync(keyPath, "utf8"), "ES256");
const jwt = await new SignJWT(payload).setProtectedHeader(header).sign(pk);
console.log(`GOTRUE_EXTERNAL_APPLE_SECRET=${jwt}`);
console.error(`(expires ${new Date(payload.exp * 1000).toISOString()} — rerun before then)`);
