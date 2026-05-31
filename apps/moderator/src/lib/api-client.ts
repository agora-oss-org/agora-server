// Calls back into @agora/api to APPLY a moderation decision (the trust boundary stays the API — the
// moderator never mutates entities/comments directly). Targets POST {API_BASE_URL}/:projectId/
// internal/moderation/apply, gated by the shared MODERATION_SERVICE_SECRET. No-op (returns false)
// when the write-back isn't configured, so verdicts still persist + queue for humans.
import { env } from "./env.js";
import { logger } from "./logger.js";

export function writeBackEnabled(): boolean {
  return !!(env.API_BASE_URL && env.MODERATION_SERVICE_SECRET);
}

export async function applyModeration(args: {
  projectId: string;
  targetType: "entity" | "comment";
  targetId: string;
  status: "removed" | "approved";
  reason?: string;
}): Promise<boolean> {
  if (!env.API_BASE_URL || !env.MODERATION_SERVICE_SECRET) return false;
  // The write-back lives at the API app root (like /internal/cron/*), not under /v7 — projectId
  // travels in the body.
  const url = `${env.API_BASE_URL.replace(/\/+$/, "")}/internal/moderation/apply`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-moderation-secret": env.MODERATION_SERVICE_SECRET,
      },
      body: JSON.stringify({ projectId: args.projectId, targetType: args.targetType, targetId: args.targetId, status: args.status, reason: args.reason }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.error({ status: res.status, targetId: args.targetId }, "moderation write-back rejected");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, targetId: args.targetId }, "moderation write-back failed");
    return false;
  }
}
