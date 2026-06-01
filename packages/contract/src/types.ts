// API response-model interfaces (return shapes; see docs/MODELS.md).
// Pure types — no hono/drizzle/runtime dependency.
import type { ReactionCounts, ReactionType } from "./reactions.js";

export interface User {
  id: string;
  projectId: string;
  foreignId: string | null;
  role: "admin" | "moderator" | "visitor";
  name: string | null;
  username: string | null;
  avatar: string | null;
  avatarFileId: string | null;
  bannerFileId: string | null;
  bio: string | null;
  birthdate: string | null;
  location: unknown | null;
  metadata: Record<string, unknown>;
  reputation: number;
  createdAt: string;
}

export interface Entity {
  id: string;
  foreignId: string | null;
  shortId: string;
  projectId: string;
  sourceId: string | null;
  spaceId: string | null;
  space?: unknown;
  userId: string | null;
  user?: User | null;
  title: string | null;
  content: string | null;
  mentions: unknown[];
  attachments: unknown[];
  files?: unknown[]; // system-managed file associations (images/files); populated on create + fetch
  keywords: string[];
  upvotes: string[];
  downvotes: string[];
  reactionCounts: ReactionCounts;
  userReaction: ReactionType | null;
  repliesCount: number;
  views: number;
  score: number;
  scoreUpdatedAt: string;
  location: unknown | null;
  metadata: Record<string, unknown>;
  isSaved?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  isDraft: boolean;
  moderationStatus: string | null;
  moderatedAt: string | null;
  moderatedById: string | null;
  moderatedByType: string | null;
  moderationReason: string | null;
}

export interface Comment {
  id: string;
  projectId: string;
  foreignId: string | null;
  entityId: string;
  userId: string | null;
  user?: User | null;
  parentId: string | null;
  parentComment?: Comment | null;
  content: string | null;
  gif: unknown | null;
  mentions: unknown[];
  upvotes: string[];
  downvotes: string[];
  reactionCounts: ReactionCounts;
  userReaction: ReactionType | null;
  repliesCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  userDeletedAt: string | null;
  moderationStatus: string | null;
  moderatedAt: string | null;
  moderatedById: string | null;
  moderatedByType: string | null;
  moderationReason: string | null;
}

export interface AuthUser extends User {
  email: string | null;
  isVerified: boolean;
  isActive: boolean;
  lastActive: string;
  updatedAt: string;
  suspensions: { reason: string | null; startDate: string; endDate: string | null }[];
  authMethods: string[];
  // Agora extension: true when this identity is a deployment operator (env allowlist). Grants the
  // admin app a project-wide god-view (all spaces/content/reports) instead of space-scoped authority.
  isOperator: boolean;
}

// ─── reports / moderation ──────────────────────────────────────────────────
export type ReportTargetType = "entity" | "comment" | "message";

// A user-filed report (shapeReport). Resolved when `resolvedAt` is set. `spaceId` scopes it to a
// space (the moderation + resolution endpoints are space-scoped); null = project-level report.
// Lightweight user reference for moderation list/detail views (poster + flagger names).
export interface UserSummary {
  id: string;
  username: string | null;
  name: string | null;
}

export interface Report {
  id: string;
  projectId: string;
  reporterId: string | null;
  targetType: ReportTargetType;
  targetId: string;
  spaceId: string | null;
  reason: string;
  details: string | null;
  resolvedAt: string | null;
  resolvedById: string | null;
  createdAt: string;
  // Resolved display names (populated by the moderation list/detail endpoints; absent elsewhere).
  author?: UserSummary | null;   // the poster (content author)
  reporter?: UserSummary | null; // the flagger (who filed the report)
}

// Auth identity attached to a request (set by middleware, returned in some payloads).
export interface AuthContext {
  userId: string; // Agora profile id
  role: "admin" | "moderator" | "visitor";
  isOperator: boolean; // deployment operator (env allowlist) — project-wide moderation/admin
}

// ─── automated moderation (@agora/moderator) ───────────────────────────────
// The LLM's structured judgement of a piece of content. "allow" = clean; "block" = clearly
// violates policy; "review" = uncertain, route to a human. `confidence` is 0..1.
export type ModerationVerdict = "allow" | "block" | "review";

// One stored LLM assessment (shapeModerationAnalysis). The moderator service persists one row per
// assessment; the admin app reads these to triage the AI-flag queue and surface reasoning in review.
export interface ModerationAnalysis {
  id: string;
  projectId: string;
  targetType: ReportTargetType; // entity | comment | message
  targetId: string;
  spaceId: string | null;
  verdict: ModerationVerdict;
  categories: string[]; // policy categories matched, e.g. ["harassment","spam"]
  confidence: number; // 0..1
  reason: string; // short LLM rationale
  model: string; // provider/model that produced it, e.g. "openai:gpt-4o-mini"
  autoActioned: boolean; // true when the moderator wrote the removal back to the API itself
  humanResolvedAt: string | null; // set once a human dispositions it (clears it from the queue)
  createdAt: string;
  author?: UserSummary | null; // the poster (content author); populated by the AI-flag queue
}
