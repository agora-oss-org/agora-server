// Refresh-token cleanup sweep. Deletes EXPIRED refresh tokens (past their TTL) — the bulk of dead
// rows: old rotated tokens, signed-out / reuse-revoked / password-change families all age out here.
//
// We intentionally key off `expires_at`, NOT `revoked`. Reuse-detection (lib/tokens.ts) checks
// rotated/revoked state BEFORE expiry, so an UNEXPIRED token replayed within its validity still
// revokes its family — real theft defense. Deleting unexpired-but-revoked rows would drop that
// signal. Since every token carries a fixed TTL, expiry alone bounds table growth while preserving
// the defense. Runs via POST /internal/cron/purge-tokens (CRON_SECRET) or scripts/purge-tokens.mjs.
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export async function purgeExpiredRefreshTokens(): Promise<{ deleted: number }> {
  // CTE so the affected-row count is returned portably (independent of the driver's result shape).
  const rows = await db.execute(sql`
    with del as (delete from refresh_tokens where expires_at < now() returning 1)
    select count(*)::int as n from del`);
  return { deleted: Number((rows as unknown as { n: number }[])[0]?.n ?? 0) };
}
