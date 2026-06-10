import { describe, expect, it } from "vitest";
import {
  CORPORATE_ONLY_FLAGS,
  forbiddenSocialKeys,
  resolveSocialConfig,
  resultingSocialTier,
  SOCIAL_PRIVACY_TIERS,
  SOCIAL_TIER_DEFAULTS,
  socialConfigSchema,
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
  it("rejects constellationKFloor below 5 — the k-anonymity floor is not tier-relaxable", () => {
    expect(socialConfigSchema.safeParse({ constellationKFloor: 4 }).success).toBe(false);
    expect(socialConfigSchema.safeParse({ constellationKFloor: 5 }).success).toBe(true);
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
    expect(d.frictionVisibleToStewards).toBe(true);
    expect(d.readAffinityEnabled).toBe(true);
    for (const k of CORPORATE_ONLY_FLAGS) expect(d[k]).toBe(false);
    expect(d.constellationKFloor).toBe(5);
    expect(d.warmthHalfLifeDays).toBe(30);
    expect(d.frictionHalfLifeDays).toBe(14);
  });
  it("corporate defaults: analytics on, k-floor still 5", () => {
    const d = SOCIAL_TIER_DEFAULTS.corporate;
    expect(d.privacyTier).toBe("corporate");
    for (const k of CORPORATE_ONLY_FLAGS) expect(d[k]).toBe(true);
    expect(d.constellationKFloor).toBe(5); // k-anonymity is not tier-relaxable
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
  it("CLAMP: a stored k-floor below 5 is raised to 5", () => {
    expect(resolveSocialConfig({ constellationKFloor: 2 }).constellationKFloor).toBe(5);
  });
  it("ignores non-boolean garbage in boolean fields (falls back to default)", () => {
    expect(resolveSocialConfig({ weatherEnabled: "yes" }).weatherEnabled).toBe(true);
  });
  it("tiers are exactly community and corporate", () => {
    expect(SOCIAL_PRIVACY_TIERS).toEqual(["community", "corporate"]);
  });
  it("rejects float/Infinity/NaN numerics at read time (falls back to defaults)", () => {
    expect(resolveSocialConfig({ constellationKFloor: Infinity }).constellationKFloor).toBe(5);
    expect(resolveSocialConfig({ constellationKFloor: NaN }).constellationKFloor).toBe(5);
    expect(resolveSocialConfig({ warmthHalfLifeDays: 12.5 }).warmthHalfLifeDays).toBe(30);
  });
  it("an out-of-range stored k-floor (above the 1000 ceiling) falls back to the default", () => {
    expect(resolveSocialConfig({ constellationKFloor: 2000 }).constellationKFloor).toBe(5);
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
