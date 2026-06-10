import { describe, expect, it } from "vitest";
import { SOCIAL_TIER_DEFAULTS, resolveSocialConfig } from "@agora-server/contract";
import { socialConfigView, transparencyView } from "./social-config.js";

describe("socialConfigView", () => {
  it("returns stored overrides + effective config side by side", () => {
    const stored = { privacyTier: "corporate", weatherEnabled: false };
    const view = socialConfigView(stored, resolveSocialConfig(stored));
    expect(view.stored).toEqual(stored);
    expect(view.effective.privacyTier).toBe("corporate");
    expect(view.effective.weatherEnabled).toBe(false);
    expect(view.effective.readReceiptsAllowed).toBe(true);
  });
  it("treats garbage stored state as empty", () => {
    const view = socialConfigView("nonsense", resolveSocialConfig("nonsense"));
    expect(view.stored).toEqual({});
    expect(view.effective).toEqual(SOCIAL_TIER_DEFAULTS.community);
  });
});

describe("transparencyView — the member-facing invariant (docs/AGORA-CORP.md §4.5)", () => {
  it("exposes tier + analytics + garden surfaces, nothing else", () => {
    const t = transparencyView(SOCIAL_TIER_DEFAULTS.corporate);
    expect(t).toEqual({
      privacyTier: "corporate",
      analytics: {
        influenceScores: true,
        siloDetection: true,
        engagementScores: true,
        frictionAnalytics: true,
        readReceiptsAllowed: true,
      },
      garden: { graph: true, weather: true, constellation: true, neighborhood: true, readAffinity: true },
      decay: { warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 },
    });
  });
  it("community tier reads all-analytics-off", () => {
    const t = transparencyView(SOCIAL_TIER_DEFAULTS.community);
    expect(Object.values(t.analytics).every((v) => v === false)).toBe(true);
  });
});
