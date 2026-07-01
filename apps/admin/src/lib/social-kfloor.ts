/** Hard anonymity floor — a blob always represents ≥2 people (mirrors the contract's resolveKFloor). */
export const KFLOOR_HARD_MIN = 2;
export const KFLOOR_MAX = 1000;

/** Clamp a raw numeric input to a valid explicit floor: integer in [2, 1000].
 *  Non-finite (NaN, ±Infinity) → the hard minimum. */
export function clampKFloor(raw: number): number {
  if (!Number.isFinite(raw)) return KFLOOR_HARD_MIN;
  return Math.max(KFLOOR_HARD_MIN, Math.min(KFLOOR_MAX, Math.round(raw)));
}

/** Human-readable rows describing the adaptive curve — kept in lockstep with the contract's
 *  adaptiveConstellationFloor (asserted in social-kfloor.test.ts). Purely for display. */
export const ADAPTIVE_KFLOOR_TIERS = [
  { range: "< 50", floor: 2 },
  { range: "50–99", floor: 3 },
  { range: "100–499", floor: 4 },
  { range: "≥ 500", floor: 5 },
] as const;
