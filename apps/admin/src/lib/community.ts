// Community-health pulse: the operator-only dashboard reads a shaped overview from
// GET /admin/community/overview (backed by the hourly community_stats_hourly rollup). Pulse totals +
// 24h deltas, a per-hour growth/moderation series, and the latest leaderboard + top-post snapshot
// (ranking ids stored in the rollup; the API hydrates display fields). `configured:false` until the
// first rollup cron has run.
import type { User } from "@agora/contract";
import { api } from "./api";

export interface CommunitySeriesPoint {
  hour: string;
  newUsers: number;
  newPosts: number;
  newComments: number;
  newReactions: number;
  activePosters: number;
  activeCommenters: number;
  activeReactors: number;
}

export interface CommunityLeader {
  user: User;
  count: number;
}

export interface CommunityTopPost {
  entity: {
    id: string;
    shortId: string;
    title: string | null;
    repliesCount: number;
    score: number;
    createdAt: string;
  };
  reactions: number;
  replies: number;
}

export interface CommunityOverview {
  configured: boolean;
  range: { days: number };
  snapshotAt: string | null;
  totals: { users: number; posts: number; comments: number; reactions: number };
  deltas24h: { users: number; posts: number; comments: number; reactions: number } | null;
  series: CommunitySeriesPoint[];
  moderation: { series: { hour: string; opened: number; resolved: number }[]; openNow: number };
  leaderboards: {
    posters: CommunityLeader[];
    commenters: CommunityLeader[];
    reactors: CommunityLeader[];
  };
  topPosts: CommunityTopPost[];
}

export const communityOverviewKey = (days: number) => ["community-overview", days] as const;

export function getCommunityOverview(days: number, signal?: AbortSignal): Promise<CommunityOverview> {
  return api<CommunityOverview>("/admin/community/overview", { query: { days }, signal });
}
