import { describe, it, expect } from "vitest";
import { adaptiveConstellationFloor } from "@agora-server/contract";
import { clampKFloor, KFLOOR_HARD_MIN, KFLOOR_MAX, ADAPTIVE_KFLOOR_TIERS } from "./social-kfloor.js";

describe("clampKFloor", () => {
  it("raises 1 to the hard minimum (2)", () => {
    expect(clampKFloor(1)).toBe(2);
  });
  it("leaves 2 unchanged (hard minimum)", () => {
    expect(clampKFloor(2)).toBe(2);
  });
  it("leaves 5 unchanged", () => {
    expect(clampKFloor(5)).toBe(5);
  });
  it("leaves 1000 unchanged (hard maximum)", () => {
    expect(clampKFloor(1000)).toBe(1000);
  });
  it("clamps 2000 down to 1000", () => {
    expect(clampKFloor(2000)).toBe(1000);
  });
  it("raises 0 to 2", () => {
    expect(clampKFloor(0)).toBe(2);
  });
  it("raises -4 to 2", () => {
    expect(clampKFloor(-4)).toBe(2);
  });
  it("maps NaN to the hard minimum (non-finite)", () => {
    expect(clampKFloor(NaN)).toBe(KFLOOR_HARD_MIN);
  });
  it("maps Infinity to the hard minimum (non-finite → hard min)", () => {
    expect(clampKFloor(Infinity)).toBe(KFLOOR_HARD_MIN);
  });
  it("rounds 12.5 to 13", () => {
    expect(clampKFloor(12.5)).toBe(13);
  });

  it("exports KFLOOR_HARD_MIN = 2", () => {
    expect(KFLOOR_HARD_MIN).toBe(2);
  });
  it("exports KFLOOR_MAX = 1000", () => {
    expect(KFLOOR_MAX).toBe(1000);
  });
});

describe("ADAPTIVE_KFLOOR_TIERS lockstep with contract's adaptiveConstellationFloor", () => {
  // Each row in ADAPTIVE_KFLOOR_TIERS maps to a representative member count.
  // These assertions double-check that the display table and the contract function agree.
  const cases: Array<{ memberCount: number; expectedFloor: number; label: string }> = [
    { memberCount: 10,    expectedFloor: 2, label: "deep inside < 50 (tier row 0)" },
    { memberCount: 49,    expectedFloor: 2, label: "upper edge of < 50 (tier row 0)" },
    { memberCount: 50,    expectedFloor: 3, label: "lower edge of 50–99 (tier row 1)" },
    { memberCount: 99,    expectedFloor: 3, label: "upper edge of 50–99 (tier row 1)" },
    { memberCount: 100,   expectedFloor: 4, label: "lower edge of 100–499 (tier row 2)" },
    { memberCount: 499,   expectedFloor: 4, label: "upper edge of 100–499 (tier row 2)" },
    { memberCount: 500,   expectedFloor: 5, label: "lower edge of ≥ 500 (tier row 3)" },
    { memberCount: 10000, expectedFloor: 5, label: "deep inside ≥ 500 (tier row 3)" },
  ];

  for (const { memberCount, expectedFloor, label } of cases) {
    it(`adaptiveConstellationFloor(${memberCount}) = ${expectedFloor} — ${label}`, () => {
      expect(adaptiveConstellationFloor(memberCount)).toBe(expectedFloor);
    });
  }

  it("ADAPTIVE_KFLOOR_TIERS has exactly 4 rows matching the curve", () => {
    expect(ADAPTIVE_KFLOOR_TIERS).toHaveLength(4);
    // Row 0: < 50 → 2
    expect(adaptiveConstellationFloor(0)).toBe(ADAPTIVE_KFLOOR_TIERS[0].floor);
    // Row 1: 50–99 → 3
    expect(adaptiveConstellationFloor(50)).toBe(ADAPTIVE_KFLOOR_TIERS[1].floor);
    // Row 2: 100–499 → 4
    expect(adaptiveConstellationFloor(100)).toBe(ADAPTIVE_KFLOOR_TIERS[2].floor);
    // Row 3: ≥ 500 → 5
    expect(adaptiveConstellationFloor(500)).toBe(ADAPTIVE_KFLOOR_TIERS[3].floor);
  });
});
