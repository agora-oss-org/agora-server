import { describe, expect, it } from "vitest";
import {
  adaptiveConstellationFloor,
  CORPORATE_ONLY_FLAGS,
  forbiddenSocialKeys,
  readReceiptCoverage,
  readReceiptsToggleSchema,
  resolveSocialConfig,
  resultingSocialTier,
  SOCIAL_PRIVACY_TIERS,
  SOCIAL_TIER_DEFAULTS,
  socialConfigSchema,
  WEATHER_BANDS,
} from "./social.js";

describe("socialConfigSchema — PATCH body contract", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(socialConfigSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a full valid corporate patch", () => {
    expect(
      socialConfigSchema.safeParse({
        privacyTier: "corporate",
        readReceiptsAllowed: true,
        engagementScoresEnabled: true,
        constellationKFloor: 10,
        warmthHalfLifeDays: 60,
      }).success,
    ).toBe(true);
  });
  it("rejects an unknown tier", () => {
    expect(socialConfigSchema.safeParse({ privacyTier: "surveillance" }).success).toBe(false);
  });
  it("rejects constellationKFloor below 2 — the hard k-anonymity floor is not tier-relaxable", () => {
    expect(socialConfigSchema.safeParse({ constellationKFloor: 1 }).success).toBe(false);
    expect(socialConfigSchema.safeParse({ constellationKFloor: 2 }).success).toBe(true);
    expect(socialConfigSchema.safeParse({ constellationKFloor: 1001 }).success).toBe(false);
    expect(socialConfigSchema.safeParse({ constellationKFloor: null }).success).toBe(true);
    expect(socialConfigSchema.safeParse({}).success).toBe(true); // omitted is valid
  });
  it("rejects non-positive half-lives", () => {
    expect(socialConfigSchema.safeParse({ warmthHalfLifeDays: 0 }).success).toBe(false);
    expect(socialConfigSchema.safeParse({ frictionHalfLifeDays: -3 }).success).toBe(false);
  });
});

describe("SOCIAL_TIER_DEFAULTS — the two postures", () => {
  it("community defaults: garden on, every corporate analytic off, receipts locked off", () => {
    const d = SOCIAL_TIER_DEFAULTS.community;
    expect(d.privacyTier).toBe("community");
    expect(d.weatherEnabled).toBe(true);
    expect(d.constellationEnabled).toBe(true);
    expect(d.neighborhoodEnabled).toBe(true);
    expect(d.neighborhoodIncludeInteractions).toBe(false); // structural-only by default
    expect(d.frictionVisibleToStewards).toBe(true);
    expect(d.readAffinityEnabled).toBe(true);
    for (const k of CORPORATE_ONLY_FLAGS) expect(d[k]).toBe(false);
    expect(d.constellationKFloor).toBe(null);
    expect(d.warmthHalfLifeDays).toBe(30);
    expect(d.frictionHalfLifeDays).toBe(14);
  });
  it("corporate defaults: analytics on, k-floor inherits null/adaptive", () => {
    const d = SOCIAL_TIER_DEFAULTS.corporate;
    expect(d.privacyTier).toBe("corporate");
    for (const k of CORPORATE_ONLY_FLAGS) expect(d[k]).toBe(true);
    expect(d.constellationKFloor).toBe(null); // adaptive-by-default, resolved at materialization time
  });
});

describe("forbiddenSocialKeys — reject-on-write", () => {
  it("under community, flags every corporate-only key set to true", () => {
    for (const k of CORPORATE_ONLY_FLAGS) {
      expect(forbiddenSocialKeys({ [k]: true }, "community")).toEqual([k]);
    }
  });
  it("under community, allows corporate-only keys set to false or omitted", () => {
    expect(forbiddenSocialKeys({ readReceiptsAllowed: false }, "community")).toEqual([]);
    expect(forbiddenSocialKeys({ weatherEnabled: false }, "community")).toEqual([]);
  });
  it("under corporate, allows everything", () => {
    for (const k of CORPORATE_ONLY_FLAGS) {
      expect(forbiddenSocialKeys({ [k]: true }, "corporate")).toEqual([]);
    }
  });
  it("validates against the RESULTING tier: community→corporate upgrade with a corporate flag is allowed", () => {
    expect(forbiddenSocialKeys({ privacyTier: "corporate", engagementScoresEnabled: true }, "community")).toEqual([]);
  });
  it("validates against the RESULTING tier: corporate→community downgrade with a corporate flag is rejected", () => {
    expect(forbiddenSocialKeys({ privacyTier: "community", readReceiptsAllowed: true }, "corporate")).toEqual(["readReceiptsAllowed"]);
  });
  it("a null privacyTier in the patch clears to the community default and is validated as community", () => {
    expect(forbiddenSocialKeys({ privacyTier: null, readReceiptsAllowed: true }, "corporate")).toEqual(["readReceiptsAllowed"]);
  });
  it("resultingSocialTier: patch tier wins; null clears to community; absent keeps current", () => {
    expect(resultingSocialTier({ privacyTier: "corporate" }, "community")).toBe("corporate");
    expect(resultingSocialTier({ privacyTier: null }, "corporate")).toBe("community");
    expect(resultingSocialTier({}, "corporate")).toBe("corporate");
  });
});

describe("resolveSocialConfig — clamp-on-read (fail closed)", () => {
  it("garbage/missing input resolves to full community defaults", () => {
    for (const raw of [undefined, null, 42, "hi", []]) {
      expect(resolveSocialConfig(raw)).toEqual(SOCIAL_TIER_DEFAULTS.community);
    }
  });
  it("unknown stored tier falls back to community", () => {
    expect(resolveSocialConfig({ privacyTier: "corporate-plus" }).privacyTier).toBe("community");
  });
  it("stored overrides apply on top of tier defaults", () => {
    const cfg = resolveSocialConfig({ privacyTier: "corporate", weatherEnabled: false, warmthHalfLifeDays: 90 });
    expect(cfg.weatherEnabled).toBe(false);
    expect(cfg.warmthHalfLifeDays).toBe(90);
    expect(cfg.readReceiptsAllowed).toBe(true); // corporate default survives
  });
  it("CLAMP: stale corporate flags are neutralized after a corporate→community switch", () => {
    // What's left in jsonb after an operator flips the tier back without clearing flags:
    const cfg = resolveSocialConfig({
      privacyTier: "community",
      readReceiptsAllowed: true,
      engagementScoresEnabled: true,
      influenceScoresEnabled: true,
      siloDetectionEnabled: true,
      frictionAnalyticsEnabled: true,
    });
    for (const k of CORPORATE_ONLY_FLAGS) expect(cfg[k]).toBe(false);
  });
  it("CLAMP: a stored k-floor below 2 is raised to 2; valid values pass through; absent → null (adaptive)", () => {
    expect(resolveSocialConfig({ constellationKFloor: 1 }).constellationKFloor).toBe(2);
    expect(resolveSocialConfig({ constellationKFloor: 2 }).constellationKFloor).toBe(2);
    expect(resolveSocialConfig({ constellationKFloor: 30 }).constellationKFloor).toBe(30);
    expect(resolveSocialConfig({ constellationKFloor: 1000 }).constellationKFloor).toBe(1000);
    expect(resolveSocialConfig({}).constellationKFloor).toBe(null);
  });
  it("ignores non-boolean garbage in boolean fields (falls back to default)", () => {
    expect(resolveSocialConfig({ weatherEnabled: "yes" }).weatherEnabled).toBe(true);
  });
  it("tiers are exactly community and corporate", () => {
    expect(SOCIAL_PRIVACY_TIERS).toEqual(["community", "corporate"]);
  });
  it("rejects float/Infinity/NaN numerics at read time (falls back to null for k-floor, default for others)", () => {
    expect(resolveSocialConfig({ constellationKFloor: Infinity }).constellationKFloor).toBe(null);
    expect(resolveSocialConfig({ constellationKFloor: NaN }).constellationKFloor).toBe(null);
    expect(resolveSocialConfig({ warmthHalfLifeDays: 12.5 }).warmthHalfLifeDays).toBe(30);
  });
  it("an out-of-range stored k-floor (above the 1000 ceiling) resolves to null (adaptive)", () => {
    expect(resolveSocialConfig({ constellationKFloor: 2000 }).constellationKFloor).toBe(null);
  });
});

describe("adaptiveConstellationFloor — size-based k-floor", () => {
  it("returns 2 for small communities (0 and 49 members)", () => {
    expect(adaptiveConstellationFloor(0)).toBe(2);
    expect(adaptiveConstellationFloor(49)).toBe(2);
  });
  it("returns 3 for communities of 50–99 members", () => {
    expect(adaptiveConstellationFloor(50)).toBe(3);
    expect(adaptiveConstellationFloor(99)).toBe(3);
  });
  it("returns 4 for communities of 100–499 members", () => {
    expect(adaptiveConstellationFloor(100)).toBe(4);
    expect(adaptiveConstellationFloor(499)).toBe(4);
  });
  it("returns 5 for communities of 500+ members", () => {
    expect(adaptiveConstellationFloor(500)).toBe(5);
    expect(adaptiveConstellationFloor(10000)).toBe(5);
  });
});

describe("resolveSocialConfig — constellationKFloor resolver cases", () => {
  it("absent/garbage → null (adaptive, resolved at materialization time)", () => {
    expect(resolveSocialConfig({}).constellationKFloor).toBe(null);
    expect(resolveSocialConfig({ constellationKFloor: "x" }).constellationKFloor).toBe(null);
    expect(resolveSocialConfig({ constellationKFloor: 12.5 }).constellationKFloor).toBe(null);
  });
  it("stored 1 is raised to 2 (hard floor)", () => {
    expect(resolveSocialConfig({ constellationKFloor: 1 }).constellationKFloor).toBe(2);
  });
  it("stored 2 stays 2", () => {
    expect(resolveSocialConfig({ constellationKFloor: 2 }).constellationKFloor).toBe(2);
  });
  it("stored 30 passes through unchanged", () => {
    expect(resolveSocialConfig({ constellationKFloor: 30 }).constellationKFloor).toBe(30);
  });
});

describe("structural drift guards", () => {
  it("resolveSocialConfig({}) produces exactly the keys of the community defaults", () => {
    expect(Object.keys(resolveSocialConfig({})).sort()).toEqual(Object.keys(SOCIAL_TIER_DEFAULTS.community).sort());
  });
  it("every schema key resolves to a config key (a field added to the schema but not the resolver would silently never clamp)", () => {
    const schemaKeys = Object.keys(socialConfigSchema.shape).sort();
    const resolvedKeys = Object.keys(SOCIAL_TIER_DEFAULTS.community).sort();
    expect(schemaKeys).toEqual(resolvedKeys);
  });
});

describe("weather bands", () => {
  it("exposes the five bands, quiet first, no duplicates", () => {
    expect(WEATHER_BANDS).toEqual(["quiet", "stormy", "overcast", "fine", "sunny"]);
    expect(new Set(WEATHER_BANDS).size).toBe(WEATHER_BANDS.length);
  });
});

describe("readReceiptCoverage — per-post coverage", () => {
  it("is readers / members, rounded to 2dp", () => {
    expect(readReceiptCoverage(1, 4)).toBe(0.25);
    expect(readReceiptCoverage(1, 3)).toBe(0.33);
    expect(readReceiptCoverage(2, 3)).toBe(0.67);
  });
  it("is 0 when the space has no members (no denominator)", () => {
    expect(readReceiptCoverage(0, 0)).toBe(0);
    expect(readReceiptCoverage(5, 0)).toBe(0);
  });
  it("clamps to [0,1] even if readers somehow exceed members", () => {
    expect(readReceiptCoverage(5, 4)).toBe(1);
    expect(readReceiptCoverage(-1, 4)).toBe(0);
  });
});

describe("readReceiptsToggleSchema — operator toggle body", () => {
  it("requires a boolean enabled", () => {
    expect(readReceiptsToggleSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(readReceiptsToggleSchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(readReceiptsToggleSchema.safeParse({}).success).toBe(false);
  });
});
