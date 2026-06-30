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
// k-anonymity floor is NOT in this list — no tier relaxes it below 2.
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
  constellationKFloor: number | null;
  neighborhoodEnabled: boolean;
  /** When true, a member's Neighborhood also includes people they've recently *interacted* with (not
   *  just follows/connections). Default false — the project-wide default; a member can override it for
   *  their own view via the endpoint's `?includeInteractions=` query param. */
  neighborhoodIncludeInteractions: boolean;
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
  constellationKFloor: null,
  neighborhoodEnabled: true,
  neighborhoodIncludeInteractions: false,
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
  // LOCKSTEP: schema write bounds (min 2, max 1000) must stay aligned with resolver read bounds (resolveKFloor: [1,1000] + Math.max(2)); change both together.
  constellationKFloor: z.number().int().min(2).max(1000).nullish(),
  neighborhoodEnabled: z.boolean().nullish(),
  neighborhoodIncludeInteractions: z.boolean().nullish(),
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

/** Resolve a stored k-floor value. null/absent/malformed/out-of-[1,1000] → null (adaptive,
 *  resolved at materialization time via adaptiveConstellationFloor); integer in [1,1000] → raised
 *  to ≥2 (the hard anonymity floor). The hard floor of 2 lives here and in adaptiveConstellationFloor. */
function resolveKFloor(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1000) return null;
  return Math.max(2, v);
}

/** The adaptive (default) k-floor for a project of `memberCount` people. Always ≥2 (the hard
 *  anonymity floor) and ≤5 (the large-community default). Used when constellationKFloor is null. */
export function adaptiveConstellationFloor(memberCount: number): number {
  if (memberCount < 50) return 2;
  if (memberCount < 100) return 3;
  if (memberCount < 500) return 4;
  return 5;
}

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
    // LOCKSTEP: resolver read bounds (resolveKFloor: [1,1000] + Math.max(2)) must stay aligned with schema write bounds (min 2, max 1000); change both together.
    // null/absent/malformed/out-of-[1,1000] → null (adaptive, resolved at materialization time); a stored value in [1,1000] is raised to ≥2.
    constellationKFloor: resolveKFloor(r.constellationKFloor),
    neighborhoodEnabled: bool(r.neighborhoodEnabled, d.neighborhoodEnabled),
    neighborhoodIncludeInteractions: bool(r.neighborhoodIncludeInteractions, d.neighborhoodIncludeInteractions),
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

// ── Community Weather (GET /v7/:projectId/social/weather) ───────────────────────────────────────
// One aggregate scalar — the only place friction shows publicly, as a dip in collective climate
// (docs/AGORA-SOCIAL.md §5). Safe to publish per the magnitude-regime theorem: friction big enough
// to move this number involves too many people to single anyone out.

export const WEATHER_BANDS = ["quiet", "stormy", "overcast", "fine", "sunny"] as const;
export type WeatherBand = (typeof WEATHER_BANDS)[number];

export interface SocialWeather {
  /** Mean S_p over the project; null when the graph has no interactions yet. 0..1 rounded to 2dp
   *  is a runtime convention of the server's weather computation, not enforced by this type. */
  value: number | null;
  /** Bucketed label, never null. "quiet" is ONLY the no-data sentinel (value === null); a low
   *  score with data is "stormy". Band moves with hysteresis — see apps/api lib/social-weather. */
  band: WeatherBand;
  /** value(now) − value(as of 7 days ago), 3dp; null when either window has no data. */
  trend: number | null;
  /** ISO timestamp of computation (results are cached ~1h server-side). */
  asOf: string;
}

// ── Neighborhood (GET /v7/:projectId/social/neighborhood) ───────────────────────────────────────
// The most personal Garden lens (docs/AGORA-SOCIAL.md): zoom to YOURSELF — your own named ties, each
// rendered with its DYADIC brightness B(me, them). Self-view only. The brightness is *your tie's*
// warmth, NEVER the friend's global score — the asymmetry rule that closes the friction side-channel
// (cheat-sheet #6). Friction only DIMS an existing tie (FLOOR-bounded, so dim = friction-or-loneliness,
// unreadable); it never creates one.

export const NEIGHBORHOOD_TIE_KINDS = ["follow", "connection", "interaction", "coParticipation"] as const;
export type NeighborhoodTieKind = (typeof NEIGHBORHOOD_TIE_KINDS)[number];

export interface NeighborhoodTie {
  /** The friend's profile id (= the graph User id). */
  userId: string;
  username: string | null;
  name: string | null;
  avatar: string | null;
  /** Dyadic brightness B(me, them) in [0.15, 1], rounded to 2dp. This is the caller's *tie* warmth —
   *  NOT the friend's global S_p, which is never exposed to a member. */
  brightness: number;
  /** Which relationship(s) make this person a tie: a follow, a (mutual) connection, recent
   *  interaction, and/or co-participation (commenting in the same thread). A pair whose only edge is
   *  friction never appears (friction isn't structure). */
  tieKinds: NeighborhoodTieKind[];
}

export interface SocialNeighborhood {
  /** The caller's ties, brightest-first. */
  ties: NeighborhoodTie[];
  /** The effective tie-set rule for this response: when true, interaction-only ties are included
   *  (not just follows/connections). Echoes the resolved query-param-or-project-default so a client
   *  can reflect the actual state of its toggle. */
  includesInteractions: boolean;
  /** Whether CO_PARTICIPATES (co-commenter) ties were folded into the neighbor set for this response.
   *  Echoes the request's ?includeCoParticipates flag (default false). A neutral structural edge: it can
   *  only ADD a neighbor (at the floor brightness), never change warmth or friction. */
  includesCoParticipates: boolean;
  /** ISO timestamp of computation. */
  asOf: string;
}

// ── Constellation (GET /v7/:projectId/social/constellation) ─────────────────────────────────────
// The anonymous *shape* of the community (docs/AGORA-SOCIAL.md, §12): cluster blobs — size + warmth
// tint only, NEVER individual nodes. k-anonymity (clusters below the floor are suppressed), no
// persistent blob identity (re-clustered fresh each epoch, shuffled), warmth-only (friction never
// renders as structure). Materialized on a slow seasonal cadence (never per-load — §12), so the read
// just returns the latest snapshot.

export const BLOB_SIZE_BUCKETS = ["5–9", "10–19", "20–49", "50–99", "100+"] as const;
export type BlobSizeBucket = (typeof BLOB_SIZE_BUCKETS)[number];

export interface ConstellationBlob {
  /** Bucketed member count — coarse on purpose (one of the §12 protections). Never an exact size. */
  size: BlobSizeBucket;
  /** Warmth tint, banded (reuses the Weather band scale). Warmth-only — friction never renders here. */
  warmth: WeatherBand;
}

export interface SocialConstellation {
  /** The community's blobs, shuffled — there is NO stable identity or ordering across epochs. Blobs
   *  carry no ids, names, or member lists; a cluster smaller than the k-anonymity floor is omitted. */
  blobs: ConstellationBlob[];
  /** ISO timestamp of the materialized snapshot, or null when none has been computed yet ("forming"). */
  asOf: string | null;
  /** Which clustering produced this snapshot (transparency): GDS Louvain, the by-space fallback, or
   *  null when not yet materialized. */
  method: "louvain" | "space" | null;
}

// ── Admin Analytics (corporate tier · operator-only · NAMED) ────────────────────────────────────
// The corporate counterpart to the Garden (docs/AGORA-CORP.md; docs/SOCIAL-GRAPH.md §7 Phase 4).
// Unlike the member-facing lenses these NAME real people — the operator is the accountable employer,
// so the temporal-anonymity protections do NOT apply. Each report is corporate-tier-only, gated by its
// CORPORATE_ONLY_FLAG (`influenceScoresEnabled` / `siloDetectionEnabled` / `engagementScoresEnabled`),
// which the community tier forces off. Materialized on a slow (weekly) cadence plus an operator-forced
// recompute; the reads return the latest snapshot, names hydrated fresh so they never go stale.

export const SOCIAL_ANALYTICS_REPORTS = ["influence", "silos", "engagement"] as const;
export type SocialAnalyticsReport = (typeof SOCIAL_ANALYTICS_REPORTS)[number];

// Influence — informal leaders (PageRank) + bridge people (betweenness). GET /admin/social/influence.
export interface InfluenceMember {
  /** Profile id (= the graph User id). */
  userId: string;
  username: string | null;
  name: string | null;
  avatar: string | null;
  /** GDS PageRank centrality — overall influence across the interaction/structural graph. */
  pageRank: number;
  /** GDS betweenness centrality — how often this person sits on shortest paths (a bridge/broker). */
  betweenness: number;
}

export interface SocialInfluence {
  /** Informal leaders, highest PageRank first. */
  leaders: InfluenceMember[];
  /** Bridge people, highest betweenness first. */
  bridges: InfluenceMember[];
  /** ISO timestamp of the materialized snapshot, or null when none has been computed yet. */
  asOf: string | null;
}

// Silos — the NAMED, space-mapped form of the Constellation's clusters (GDS Louvain). No k-anonymity:
// the operator sees exact sizes and named members. GET /admin/social/silos.
export interface SiloMember {
  userId: string;
  username: string | null;
  name: string | null;
  avatar: string | null;
}

export interface SiloSpace {
  spaceId: string;
  name: string | null;
  /** How many of this silo's members belong to the space — the mapping that labels the cluster. */
  memberCount: number;
}

export interface Silo {
  /** Stable only WITHIN a snapshot (the GDS community id); no identity across epochs. */
  id: string;
  /** Exact member count — operator view, no bucketing and no suppression. */
  size: number;
  members: SiloMember[];
  /** The spaces this silo concentrates in, most-represented first — the human label for the cluster. */
  spaces: SiloSpace[];
}

export interface SocialSilos {
  silos: Silo[];
  asOf: string | null;
}

// Engagement — per-person warmth-RECEIVED (S_p) with a churn-risk trend. GET /admin/social/engagement.
export const CHURN_RISK_BANDS = ["none", "watch", "at-risk"] as const;
export type ChurnRiskBand = (typeof CHURN_RISK_BANDS)[number];

export interface EngagementMember {
  userId: string;
  username: string | null;
  name: string | null;
  avatar: string | null;
  /** Current mean inbound brightness S_p (warmth this person receives) — the latest snapshot's value. */
  sP: number;
  /** Trailing per-snapshot S_p series, oldest→newest (one point per weekly epoch in the window). */
  trend: number[];
  /** sP(current) − sP(window start); negative = cooling. */
  delta: number;
  /** Banded churn risk derived from the trend's relative decline over the window. */
  churnRisk: ChurnRiskBand;
}

export interface SocialEngagement {
  members: EngagementMember[];
  asOf: string | null;
}

// POST /admin/social/recompute — operator-forced, synchronous re-materialization. The body selects a
// single report or "all" (default); the request blocks while GDS runs over the whole graph.
export const SOCIAL_ANALYTICS_RECOMPUTE_TARGETS = [...SOCIAL_ANALYTICS_REPORTS, "all"] as const;
export const socialAnalyticsRecomputeSchema = z.object({
  report: z.enum(SOCIAL_ANALYTICS_RECOMPUTE_TARGETS).nullish(),
});
export type SocialAnalyticsRecompute = z.infer<typeof socialAnalyticsRecomputeSchema>;

// ── Read receipts (corporate tier · per-space opt-in) ───────────────────────────────────────────
// The compliance counterpart to the private feed-affinity reads (docs/SOCIAL-GRAPH.md §4): a space the
// operator marks `readReceiptsEnabled` records a proper READ row per (entity, member) — DISCLOSED to
// members (the space carries the flag), scoped to that space, and queryable ONLY by the operator. Pure
// Postgres; never written to Neo4j or the social graph. Community tier can never enable it
// (`readReceiptsAllowed` is a CORPORATE_ONLY_FLAG, clamped off above). Live read — no snapshot, no cron.

// POST /v7/:projectId/entities/:id/read — a member records having read an announcement post. Idempotent
// (one row per member per post; re-reads bump readAt). Gated on the entity's space being receipts-enabled.
export interface ReadReceiptRecorded {
  recorded: boolean;
  /** ISO timestamp the read was recorded/refreshed. */
  readAt: string;
}

// GET /admin/social/read-receipts — per-space, per-post coverage over receipts-enabled spaces.
export interface ReceiptAnnouncement {
  /** The announcement entity (post) id. */
  entityId: string;
  /** The entity's title, hydrated fresh at read; null when the post has no title. */
  title: string | null;
  /** ISO creation timestamp of the post. */
  createdAt: string;
  /** Distinct active space members who have read this post. */
  readerCount: number;
  /** readerCount / memberCount in [0,1], 2dp — the share of the space that has seen this post. */
  coverage: number;
}

export interface ReceiptSpace {
  spaceId: string;
  name: string | null;
  /** Active members of the space — the coverage denominator. */
  memberCount: number;
  /** Recent posts in the space, newest first. */
  announcements: ReceiptAnnouncement[];
}

export interface SocialReadReceipts {
  spaces: ReceiptSpace[];
  /** ISO timestamp of the (live) computation. */
  asOf: string;
}

/** Coverage = distinct member readers / active members, clamped to [0,1] and rounded to 2dp.
 *  Zero members → 0 (no denominator). Pure so it's unit-testable and identical on both sides. */
export function readReceiptCoverage(readerCount: number, memberCount: number): number {
  if (memberCount <= 0) return 0;
  const c = Math.min(1, Math.max(0, readerCount / memberCount));
  return Math.round(c * 100) / 100;
}

// PATCH /admin/social/read-receipts/spaces/:spaceId — operator flips a single space's opt-in.
export const readReceiptsToggleSchema = z.object({
  enabled: z.boolean(),
});
export type ReadReceiptsToggle = z.infer<typeof readReceiptsToggleSchema>;
