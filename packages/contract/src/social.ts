import { z } from "zod";

// ── Social graph config (projects.social_config jsonb) ──────────────────────────────────────────
// The community↔corporate privacy switch — see docs/SOCIAL-GRAPH.md §5 and docs/AGORA-CORP.md §4.
// The tier selects DEFAULTS; stored keys override within what the tier allows. Two enforcement
// points, both server-side: forbiddenSocialKeys() rejects disallowed writes (400), and
// resolveSocialConfig() clamps at read time (defense-in-depth for stale flags left behind by a
// corporate→community switch). Fail closed: garbage resolves to community defaults.

export const SOCIAL_PRIVACY_TIERS = ["community", "corporate"] as const;
export type SocialPrivacyTier = (typeof SOCIAL_PRIVACY_TIERS)[number];

// Flags that may only be true under the corporate tier. INVARIANT (docs/AGORA-CORP.md §4): the
// k-anonymity floor is NOT in this list — no tier relaxes it below 5.
export const CORPORATE_ONLY_FLAGS = [
  "influenceScoresEnabled",
  "siloDetectionEnabled",
  "engagementScoresEnabled",
  "frictionAnalyticsEnabled",
  "readReceiptsAllowed",
] as const;
export type CorporateOnlyFlag = (typeof CORPORATE_ONLY_FLAGS)[number];

export interface ResolvedSocialConfig {
  privacyTier: SocialPrivacyTier;
  graphEnabled: boolean;
  weatherEnabled: boolean;
  constellationEnabled: boolean;
  constellationKFloor: number;
  neighborhoodEnabled: boolean;
  influenceScoresEnabled: boolean;
  siloDetectionEnabled: boolean;
  engagementScoresEnabled: boolean;
  frictionVisibleToStewards: boolean;
  frictionAnalyticsEnabled: boolean;
  readAffinityEnabled: boolean;
  readReceiptsAllowed: boolean;
  warmthHalfLifeDays: number;
  frictionHalfLifeDays: number;
}

const COMMUNITY_DEFAULTS: ResolvedSocialConfig = {
  privacyTier: "community",
  graphEnabled: true,
  weatherEnabled: true,
  constellationEnabled: true,
  constellationKFloor: 5,
  neighborhoodEnabled: true,
  influenceScoresEnabled: false,
  siloDetectionEnabled: false,
  engagementScoresEnabled: false,
  frictionVisibleToStewards: true,
  frictionAnalyticsEnabled: false,
  readAffinityEnabled: true,
  readReceiptsAllowed: false,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
};

export const SOCIAL_TIER_DEFAULTS: Record<SocialPrivacyTier, ResolvedSocialConfig> = {
  community: COMMUNITY_DEFAULTS,
  corporate: {
    ...COMMUNITY_DEFAULTS,
    privacyTier: "corporate",
    influenceScoresEnabled: true,
    siloDetectionEnabled: true,
    engagementScoresEnabled: true,
    frictionAnalyticsEnabled: true,
    readReceiptsAllowed: true,
  },
};

// PATCH body (admin Settings → Social Graph). Every field nullish: omit = leave unchanged,
// null = clear the override (→ tier default). Mirrors moderatorConfigSchema.
export const socialConfigSchema = z.object({
  privacyTier: z.enum(SOCIAL_PRIVACY_TIERS).nullish(),
  graphEnabled: z.boolean().nullish(),
  weatherEnabled: z.boolean().nullish(),
  constellationEnabled: z.boolean().nullish(),
  // LOCKSTEP: schema write bounds (5–1000) must stay aligned with resolver read bounds (intIn 1–1000 + Math.max(5)); change both together.
  constellationKFloor: z.number().int().min(5).max(1000).nullish(),
  neighborhoodEnabled: z.boolean().nullish(),
  influenceScoresEnabled: z.boolean().nullish(),
  siloDetectionEnabled: z.boolean().nullish(),
  engagementScoresEnabled: z.boolean().nullish(),
  frictionVisibleToStewards: z.boolean().nullish(),
  frictionAnalyticsEnabled: z.boolean().nullish(),
  readAffinityEnabled: z.boolean().nullish(),
  readReceiptsAllowed: z.boolean().nullish(),
  warmthHalfLifeDays: z.number().int().min(1).max(365).nullish(),
  frictionHalfLifeDays: z.number().int().min(1).max(365).nullish(),
});
export type SocialConfigPatch = z.infer<typeof socialConfigSchema>;

/** The tier that results from applying `patch` over the currently-stored tier.
 *  `privacyTier: null` in a patch clears the override → community default. */
export function resultingSocialTier(
  patch: { privacyTier?: SocialPrivacyTier | null | undefined },
  currentTier: SocialPrivacyTier,
): SocialPrivacyTier {
  if (patch.privacyTier === null) return "community";
  return patch.privacyTier ?? currentTier;
}

/** Reject-on-write: keys in `patch` that the RESULTING tier (after applying the patch's own
 *  privacyTier, if any) forbids. Empty array = OK. Pass the currently-STORED tier — the
 *  current-vs-resulting derivation happens here so call sites can't get it wrong. */
export function forbiddenSocialKeys(
  patch: Partial<Record<string, unknown>> & { privacyTier?: SocialPrivacyTier | null },
  currentTier: SocialPrivacyTier,
): string[] {
  const tier = resultingSocialTier(patch, currentTier);
  if (tier === "corporate") return [];
  return CORPORATE_ONLY_FLAGS.filter((k) => patch[k] === true);
}

const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const intIn = (v: unknown, d: number, min: number, max: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d;

/** Clamp-on-read: overlay stored jsonb onto tier defaults, neutralizing anything the tier forbids. */
export function resolveSocialConfig(raw: unknown): ResolvedSocialConfig {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const tier: SocialPrivacyTier = (SOCIAL_PRIVACY_TIERS as readonly string[]).includes(r.privacyTier as string)
    ? (r.privacyTier as SocialPrivacyTier)
    : "community";
  const d = SOCIAL_TIER_DEFAULTS[tier];
  const cfg: ResolvedSocialConfig = {
    privacyTier: tier,
    graphEnabled: bool(r.graphEnabled, d.graphEnabled),
    weatherEnabled: bool(r.weatherEnabled, d.weatherEnabled),
    constellationEnabled: bool(r.constellationEnabled, d.constellationEnabled),
    // LOCKSTEP: resolver read bounds (1–1000 + Math.max(5)) must stay aligned with schema write bounds (min 5, max 1000); change both together.
    // The k-floor clamps UP only — a stored value below 5 is raised, never honored.
    constellationKFloor: Math.max(5, intIn(r.constellationKFloor, d.constellationKFloor, 1, 1000)),
    neighborhoodEnabled: bool(r.neighborhoodEnabled, d.neighborhoodEnabled),
    influenceScoresEnabled: bool(r.influenceScoresEnabled, d.influenceScoresEnabled),
    siloDetectionEnabled: bool(r.siloDetectionEnabled, d.siloDetectionEnabled),
    engagementScoresEnabled: bool(r.engagementScoresEnabled, d.engagementScoresEnabled),
    frictionVisibleToStewards: bool(r.frictionVisibleToStewards, d.frictionVisibleToStewards),
    frictionAnalyticsEnabled: bool(r.frictionAnalyticsEnabled, d.frictionAnalyticsEnabled),
    readAffinityEnabled: bool(r.readAffinityEnabled, d.readAffinityEnabled),
    readReceiptsAllowed: bool(r.readReceiptsAllowed, d.readReceiptsAllowed),
    warmthHalfLifeDays: intIn(r.warmthHalfLifeDays, d.warmthHalfLifeDays, 1, 365),
    frictionHalfLifeDays: intIn(r.frictionHalfLifeDays, d.frictionHalfLifeDays, 1, 365),
  };
  if (tier === "community") {
    for (const k of CORPORATE_ONLY_FLAGS) (cfg as Record<CorporateOnlyFlag, boolean>)[k] = false;
  }
  return cfg;
}
