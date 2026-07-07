// Per-space content digests — a separate system from project webhooks (lib/webhooks.ts).
// A space opts in via its digest_config (digest_enabled + digest_webhook_url/secret +
// digest_schedule_hour/timezone). This builds an HMAC-signed `space.digest` envelope of the
// space's recent entities and POSTs it to the space's OWN digest webhook URL — same signing
// scheme as project webhooks, but keyed by the per-space secret.
//
// The TRIGGER is intentionally decoupled from the work: sendDueDigests() is driven by
// scripts/send-digests.mjs (cron-able, standalone — no Agora server needed) and the secret-gated
// POST /internal/cron/digests endpoint (for an external scheduler / Supabase pg_cron + pg_net).
import crypto from "node:crypto";
import { and, eq, gte, isNull, desc } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { spaces, entities } from "../db/schema/index.js";
import { shapeEntity } from "./shape.js";

const TIMEOUT_MS = 8000;
const WINDOW_MS = 24 * 60 * 60 * 1000; // daily digest (schedule hour fires once/day)
const TOP_N = 10;

type SpaceRow = typeof spaces.$inferSelect;

const sign = (secret: string, msg: string) => crypto.createHmac("sha256", secret).update(msg).digest("hex");

/** Current hour (0–23) in an IANA timezone, defaulting to UTC; unknown tz → UTC. (Exported for unit tests.) */
export function hourInZone(now: Date, tz: string | null): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hour: "numeric", hour12: false }).formatToParts(now);
    return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24; // some platforms render midnight as "24"
  } catch {
    return now.getUTCHours();
  }
}

/** A space is due when it's opted in, fully configured, and the local hour matches its schedule. (Exported for unit tests.) */
export function isDue(space: SpaceRow, now: Date): boolean {
  if (!space.digestEnabled || !space.digestWebhookUrl || !space.digestWebhookSecret) return false;
  if (space.digestScheduleHour == null) return false;
  return hourInZone(now, space.digestTimezone) === space.digestScheduleHour;
}

export interface DigestSendResult {
  spaceId: string;
  ok: boolean;
  status?: number;
  entityCount?: number;
  skipped?: "no-content" | "not-configured";
  error?: string;
}

/** Build + sign + POST one space's digest. Never throws — returns the delivery outcome. */
export async function sendSpaceDigest(space: SpaceRow, now = new Date()): Promise<DigestSendResult> {
  if (!space.digestWebhookUrl || !space.digestWebhookSecret) {
    return { spaceId: space.id, ok: false, skipped: "not-configured" };
  }
  const since = new Date(now.getTime() - WINDOW_MS);
  const rows = await getDb().select().from(entities).where(and(
    eq(entities.projectId, space.projectId),
    eq(entities.spaceId, space.id),
    isNull(entities.deletedAt),
    eq(entities.isDraft, false),
    gte(entities.createdAt, since),
  )).orderBy(desc(entities.score), desc(entities.createdAt)).limit(TOP_N);

  // Nothing new this period → don't bother the receiver with an empty digest.
  if (rows.length === 0) return { spaceId: space.id, ok: true, entityCount: 0, skipped: "no-content" };

  const ts = Date.now().toString();
  const body = JSON.stringify({
    type: "space.digest",
    projectId: space.projectId,
    spaceId: space.id,
    stage: "complete",
    data: {
      space: { id: space.id, name: space.name, slug: space.slug ?? null },
      period: { since: since.toISOString(), until: now.toISOString() },
      entityCount: rows.length,
      entities: rows.map((r) => shapeEntity(r)),
    },
  });
  try {
    const res = await fetch(space.digestWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sign(space.digestWebhookSecret, `${ts}.${body}`), "x-timestamp": ts },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { spaceId: space.id, ok: res.ok, status: res.status, entityCount: rows.length };
  } catch (e: any) {
    return { spaceId: space.id, ok: false, entityCount: rows.length, error: e?.message ?? "unreachable" };
  }
}

export interface DigestRunResult {
  considered: number; // digest-enabled spaces examined
  due: number;        // of those, due to fire now
  sent: number;       // digests actually delivered (excludes no-content skips)
  results: DigestSendResult[];
}

/**
 * Find every digest-enabled space that is due now and send it. `force` ignores the schedule-hour
 * gate (manual run / test); `projectId`/`spaceId` scope the sweep.
 */
export async function sendDueDigests(
  opts: { now?: Date; force?: boolean; projectId?: string; spaceId?: string } = {}
): Promise<DigestRunResult> {
  const now = opts.now ?? new Date();
  const filters = [eq(spaces.digestEnabled, true), isNull(spaces.deletedAt)];
  if (opts.projectId) filters.push(eq(spaces.projectId, opts.projectId));
  if (opts.spaceId) filters.push(eq(spaces.id, opts.spaceId));
  const candidates = await getDb().select().from(spaces).where(and(...filters));

  const due = opts.force ? candidates : candidates.filter((s) => isDue(s, now));
  const results: DigestSendResult[] = [];
  for (const s of due) results.push(await sendSpaceDigest(s, now));
  return {
    considered: candidates.length,
    due: due.length,
    sent: results.filter((r) => r.ok && r.skipped !== "no-content").length,
    results,
  };
}
