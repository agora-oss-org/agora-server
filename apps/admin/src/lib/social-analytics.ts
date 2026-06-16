// Operator-only social-analytics dashboards (corporate tier). Reads the three NAMED reports the PR-6
// API materializes weekly — GET /admin/social/{influence,silos,engagement} — plus an operator-forced
// synchronous recompute (POST /admin/social/recompute). Each read serves the LATEST snapshot; `asOf:
// null` is the not-yet-materialized sentinel (empty arrays). All four are operator-gated + corporate-
// tier-gated server-side (a community-tier project 400s `social/<report>-disabled`); the UI mirrors the
// gate via useAuth().isOperator and renders the 400 as a friendly "corporate tier required" state.
//
// Response types are the contract's — re-exported so the page imports them from one place
// (the lib/settings.ts precedent: re-export @agora-server/contract rather than hand-copy).
import type {
  SocialInfluence,
  SocialSilos,
  SocialEngagement,
  SocialAnalyticsReport,
} from "@agora-server/contract";
import { api } from "./api";

export type {
  SocialInfluence,
  InfluenceMember,
  SocialSilos,
  Silo,
  SiloMember,
  SiloSpace,
  SocialEngagement,
  EngagementMember,
  ChurnRiskBand,
  SocialAnalyticsReport,
} from "@agora-server/contract";

export const socialInfluenceKey = ["social-influence"] as const;
export const socialSilosKey = ["social-silos"] as const;
export const socialEngagementKey = ["social-engagement"] as const;

export function getInfluence(signal?: AbortSignal): Promise<SocialInfluence> {
  return api<SocialInfluence>("/admin/social/influence", { signal });
}

export function getSilos(signal?: AbortSignal): Promise<SocialSilos> {
  return api<SocialSilos>("/admin/social/silos", { signal });
}

export function getEngagement(signal?: AbortSignal): Promise<SocialEngagement> {
  return api<SocialEngagement>("/admin/social/engagement", { signal });
}

// POST /admin/social/recompute — synchronous, blocks while GDS runs over the whole graph, then returns
// the fresh report(s). We always target a single report (the active tab), so exactly one of the
// optional report fields comes back populated.
export interface RecomputeResult {
  recomputed: SocialAnalyticsReport[];
  influence?: SocialInfluence;
  silos?: SocialSilos;
  engagement?: SocialEngagement;
}

export function recomputeAnalytics(report: SocialAnalyticsReport): Promise<RecomputeResult> {
  return api<RecomputeResult>("/admin/social/recompute", { method: "POST", body: { report } });
}
