// Cron-able reconcile: rebuild the Redis suspension index ("suspended:profiles") from the DB's
// currently-active suspensions. One ATOMIC rebuild (temp key + RENAME) simultaneously catches new
// suspensions, lifts, AND endDate expiries — no diffing. Run from apps/api with DATABASE_URL + REDIS_URL:
//   node scripts/sync-suspensions.mjs
// (The same work runs via POST /internal/cron/sync-suspensions when CRON_SECRET is set.) The index is a
// fast-path cache for suspension enforcement; @agora/api maintains it (write-through on suspend/lift +
// this reconcile) and @agora/secure-chat reads it. No-op without REDIS_URL (callers use the DB read).
import "dotenv/config";
import postgres from "postgres";
import Redis from "ioredis";

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("DATABASE_URL required"); process.exit(1); }
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) { console.log("REDIS_URL unset — suspension index disabled, nothing to reconcile."); process.exit(0); }

const KEY = "suspended:profiles";
const TMP = "suspended:profiles:rebuild";

const sql = postgres(DB, { prepare: false, onnotice() {} });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 5000 });
try {
  const rows = await sql`
    select distinct profile_id from user_suspensions
    where start_date <= now() and (end_date is null or end_date > now())`;
  const ids = rows.map((r) => r.profile_id);
  if (ids.length === 0) {
    await redis.del(KEY);
  } else {
    await redis.multi().del(TMP).sadd(TMP, ...ids).rename(TMP, KEY).exec();
  }
  console.log(`✓ suspension index reconciled — ${ids.length} active suspension(s)`);
} finally {
  await sql.end();
  redis.disconnect();
}
process.exit(0);
