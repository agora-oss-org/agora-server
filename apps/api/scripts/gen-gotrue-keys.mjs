#!/usr/bin/env node
// Generate the self-host GoTrue env trio: a JWT secret + the anon/service_role keys signed with it.
// Prints ready-to-paste env lines (by explicit user action — this is the ONE place keys go to stdout).
//   node scripts/gen-gotrue-keys.mjs                # fresh random secret
//   node scripts/gen-gotrue-keys.mjs --secret <s>   # re-derive keys from an existing secret
import { randomBytes } from "node:crypto";
import { buildGotrueKeys } from "./lib/gotrue-keys.mjs";

const i = process.argv.indexOf("--secret");
const secret = i > -1 ? process.argv[i + 1] : randomBytes(32).toString("hex");
const { anonKey, serviceKey } = await buildGotrueKeys({ secret, now: Math.floor(Date.now() / 1000) });

console.log(`GOTRUE_JWT_SECRET=${secret}`);
console.log(`SUPABASE_ANON_KEY=${anonKey}`);
console.log(`SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`);
