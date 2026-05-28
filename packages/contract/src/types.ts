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
}

// Auth identity attached to a request (set by middleware, returned in some payloads).
export interface AuthContext {
  userId: string; // Agora profile id
  role: "admin" | "moderator" | "visitor";
}
