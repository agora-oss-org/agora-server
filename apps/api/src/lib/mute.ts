import type { MuteDuration } from "@agora-server/contract";

const DELTA_MS: Record<Exclude<MuteDuration, "forever">, number> = {
  "8h": 8 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
};

/** Resolve the SDK's duration choice to concrete columns. `null` clears the mute. */
export function muteDurationToState(duration: MuteDuration | null, now: Date): { mutedUntil: Date | null; mutedForever: boolean } {
  if (duration === null) return { mutedUntil: null, mutedForever: false };
  if (duration === "forever") return { mutedUntil: null, mutedForever: true };
  return { mutedUntil: new Date(now.getTime() + DELTA_MS[duration]), mutedForever: false };
}

export function isConversationMuted(row: { mutedUntil: Date | null; mutedForever: boolean }, now: Date): boolean {
  return row.mutedForever || (row.mutedUntil !== null && row.mutedUntil.getTime() > now.getTime());
}
