#!/usr/bin/env node
// Migrate a project's NATIVE auth identities into a (self-hosted or cloud) GoTrue, then flip the
// project to auth_provider=supabase. Idempotent by email (existing GoTrue users are skipped, but
// their profile remap still runs); native rows are NEVER deleted — rollback = flip the column back.
//
//   node scripts/migrate-native-to-gotrue.mjs --project <uuid> --dry-run   # report only
//   node scripts/migrate-native-to-gotrue.mjs --project <uuid>             # apply
//
// Env: DATABASE_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (apps/api/.env is loaded).
import "dotenv/config";
import postgres from "postgres";
import { planImport, summarize } from "./lib/native-to-gotrue.mjs";

const projIdx = process.argv.indexOf("--project");
const projectId = projIdx > -1 ? process.argv[projIdx + 1] : null;
const dryRun = process.argv.includes("--dry-run");
if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) {
  console.error("Usage: migrate-native-to-gotrue.mjs --project <uuid> [--dry-run]");
  process.exit(64);
}
const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  process.exit(64);
}

const sql = postgres(DATABASE_URL, { prepare: false });
const admin = async (path, init = {}) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const rows = await sql`
  select id, email, password_hash, email_confirmed_at, disabled_at
  from auth_credentials where project_id = ${projectId} order by created_at`;
const plans = rows.map(planImport);
console.log(`Planned: ${JSON.stringify(summarize(plans))}`);
for (const p of plans) console.log(`  ${p.email}: ${p.action}${p.banned ? " (banned)" : ""}`);

if (dryRun) { console.log("Dry run — no changes made."); await sql.end(); process.exit(0); }

let failed = 0;
for (const p of plans) {
  // Idempotency: an existing GoTrue user with this email is reused, not recreated.
  const existing = await admin(`/admin/users?page=1&per_page=1&filter=${encodeURIComponent(p.email)}`);
  let userId = existing.body?.users?.find?.((u) => u.email === p.email)?.id;
  if (!userId) {
    const { status, body } = await admin("/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: p.email,
        ...(p.action === "hash-import" ? { password_hash: p.passwordHash } : {}),
        email_confirm: p.emailConfirm,
        ...(p.banned ? { ban_duration: "876600h" } : {}),
      }),
    });
    if (status >= 300 || !body.id) {
      console.error(`  FAILED ${p.email}: HTTP ${status} ${body.msg ?? body.message ?? ""}`);
      failed++;
      continue;
    }
    userId = body.id;
  }
  // Remap the profile link: native auth_user_id was the CREDENTIAL id; point it at the GoTrue user.
  const updated = await sql`
    update profiles set auth_user_id = ${userId}
    where project_id = ${projectId} and auth_user_id = ${p.credentialId}`;
  console.log(`  ${p.email}: ${p.action} → gotrue ${userId} (profiles remapped: ${updated.count})`);
}

if (failed > 0) {
  console.error(`${failed} account(s) failed — auth_provider NOT flipped. Fix and rerun (idempotent).`);
  await sql.end();
  process.exit(1);
}
await sql`update projects set auth_provider = 'supabase' where id = ${projectId}`;
console.log("auth_provider flipped to 'supabase'. The api caches the provider ~30s (lib/auth TTL);");
console.log("native rows retained — rollback = set auth_provider back to 'native'.");
await sql.end();
