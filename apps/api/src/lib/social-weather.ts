// Community Weather — the read side of the warmth math (docs/AGORA-SOCIAL.md §11, SOCIAL-GRAPH.md §3).
// Cypher returns raw per-ordered-pair decayed sums {actor, recipient, w, f}; everything formula-shaped
// (cap+floor brightness, S_p, banding with hysteresis) lives here as pure functions so it unit-tests
// without a graph. Decision log (PR 2): negative Layer-1 sentiment feeds the friction term F until
// PR 3's dedicated FRICTION edges land; per-space Weather is deferred (spaceId isn't in the graph yet).
import type { WeatherBand } from "@agora-server/contract";

// Design constants — locked by docs/AGORA-SOCIAL.md §11; deliberately NOT in social_config.
export const K_W = 10;       // warmth saturation constant
export const C_F = 0.5;      // CAP: friction can remove at most half the warmth term
export const B_FLOOR = 0.15; // FLOOR: extra-dark-equals-friction is unreadable by construction

const HYSTERESIS_MARGIN = 0.02; // band moves only on a margin-crossing change (§12)

export interface WarmthPair {
  actor: string;
  recipient: string;
  w: number; // decayed positive-sentiment sum, ≥ 0
  f: number; // decayed negative-sentiment magnitude sum, ≥ 0
}

/** Dyadic brightness B(u,v) with the CAP + FLOOR guarantees. */
export function pairBrightness(w: number, f: number): number {
  const sw = w / (w + K_W);
  const phi = f / (f + w + K_W);
  return B_FLOOR + (1 - B_FLOOR) * sw * (1 - C_F * phi);
}

/** Weather = mean over persons of S_p, where S_p = mean INBOUND brightness. Null when no pairs.
 *  Persons with no inbound pair (actors only) don't contribute an S_p — no data, no entry. Inputs
 *  are assumed clean (w, f ≥ 0 from the Cypher sums); garbage degrades to "stormy", never throws. */
export function weatherFromPairs(pairs: WarmthPair[]): number | null {
  if (pairs.length === 0) return null;
  const inbound = new Map<string, { sum: number; n: number }>();
  for (const p of pairs) {
    const acc = inbound.get(p.recipient) ?? { sum: 0, n: 0 };
    acc.sum += pairBrightness(p.w, p.f);
    acc.n += 1;
    inbound.set(p.recipient, acc);
  }
  let total = 0;
  for (const acc of inbound.values()) total += acc.sum / acc.n;
  return total / inbound.size;
}

const BAND_BOUNDS = [0.35, 0.55, 0.75] as const;
const BAND_SCALE: readonly WeatherBand[] = ["stormy", "overcast", "fine", "sunny"];

/** Bucket a weather value, holding the previous band inside HYSTERESIS_MARGIN of a boundary so the
 *  published label only moves on a persistent, margin-crossing change (docs/AGORA-SOCIAL.md §12). */
export function weatherBand(value: number | null, prevBand?: WeatherBand): WeatherBand {
  if (value == null) return "quiet";
  let idx = BAND_BOUNDS.filter((b) => value >= b).length;
  if (prevBand && prevBand !== "quiet") {
    const prevIdx = BAND_SCALE.indexOf(prevBand);
    if (Math.abs(idx - prevIdx) === 1) {
      const boundaryIdx = Math.min(idx, prevIdx) as 0 | 1 | 2;
      const boundary = BAND_BOUNDS[boundaryIdx];
      if (Math.abs(value - boundary) < HYSTERESIS_MARGIN) idx = prevIdx;
    }
  }
  // idx is 0-3 by construction (filter length on a 3-element array → 0..3)
  return BAND_SCALE[idx] as WeatherBand;
}
