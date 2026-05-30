// Cron-able cleanup: delete EXPIRED refresh tokens so the table doesn't grow unbounded. Keys on
// expiry (not `revoked`) so reuse-detection on unexpired tokens stays intact — see
// src/lib/token-cleanup.ts for the rationale. Run from apps/api with DATABASE_URL set:
//   node scripts/purge-tokens.mjs
// (The same work runs via POST /internal/cron/purge-tokens when CRON_SECRET is set.)
import "dotenv/config";
import postgres from "postgres";

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("DATABASE_URL required"); process.exit(1); }

const sql = postgres(DB, { prepare: false, onnotice() {} });
try {
  const [{ n }] = await sql`
    with del as (delete from refresh_tokens where expires_at < now() returning 1)
    select count(*)::int as n from del`;
  console.log(`✓ purged ${n} expired refresh token(s)`);
} finally {
  await sql.end();
}
process.exit(0);
