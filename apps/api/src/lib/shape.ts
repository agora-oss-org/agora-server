// Row-shaping layer: Drizzle rows -> camelCase API models matching docs/MODELS.md.
// Drizzle already returns camelCase keys; this layer normalizes Date->ISO strings,
// strips/derives fields (public User, blanked deleted comments, userReaction, isSaved),
// and nests included relations. The reusable contract surface every domain copies.
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  reactions, profiles, spaces, spaceRules, collections, appNotifications, reports,
  conversations, conversationMembers, chatMessages, files,
} from "../db/schema/index.js";
import { REACTION_TYPES } from "@agora/contract";
import type { ReactionType, ReactionCounts, User, Entity, Comment, AuthUser } from "@agora/contract";

// ─── Shared contract surface (re-exported from @agora/contract) ──────────────
// The reaction taxonomy + API model interfaces now live in @agora/contract (shared with the
// admin frontend). Re-exported here so existing `./shape.js` importers keep working unchanged.
export { REACTION_TYPES };
export type { ReactionType, ReactionCounts, User, Entity, Comment, AuthUser };

// Drizzle inferred row types.
type ProfileRow = typeof profiles.$inferSelect;
// entities/comments rows are passed structurally to avoid a hard import cycle here.
type EntityRow = Record<string, any>;
type CommentRow = Record<string, any>;

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Dates serialize as ISO strings (MODELS.md). Drizzle returns Date for timestamptz. */
function iso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

// ─── Shapers ─────────────────────────────────────────────────────────────────

/** Public user (omits email/secureMetadata/isVerified/isActive/lastActive/updatedAt). */
export function shapeUser(row: ProfileRow | null | undefined): User | null {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    foreignId: row.foreignId ?? null,
    role: row.role,
    name: row.name ?? null,
    username: row.username ?? null,
    avatar: row.avatar ?? null,
    avatarFileId: row.avatarFileId ?? null,
    bannerFileId: row.bannerFileId ?? null,
    bio: row.bio ?? null,
    birthdate: row.birthdate ?? null,
    location: null, // PostGIS column not modeled in Drizzle; populated in a later pass
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    reputation: row.reputation ?? 0,
    createdAt: iso(row.createdAt)!,
  };
}

export function shapeEntity(
  row: EntityRow,
  opts: { userReaction?: ReactionType | null; isSaved?: boolean; user?: User | null; files?: unknown[] } = {}
): Entity {
  const entity: Entity = {
    id: row.id,
    foreignId: row.foreignId ?? null,
    shortId: row.shortId,
    projectId: row.projectId,
    sourceId: row.sourceId ?? null,
    spaceId: row.spaceId ?? null,
    userId: row.userId ?? null,
    title: row.title ?? null,
    content: row.content ?? null,
    mentions: (row.mentions as unknown[]) ?? [],
    attachments: (row.attachments as unknown[]) ?? [],
    keywords: row.keywords ?? [],
    upvotes: row.upvotes ?? [],
    downvotes: row.downvotes ?? [],
    reactionCounts: row.reactionCounts as ReactionCounts,
    userReaction: opts.userReaction ?? null,
    repliesCount: row.repliesCount ?? 0,
    views: row.views ?? 0,
    score: row.score ?? 0,
    scoreUpdatedAt: iso(row.scoreUpdatedAt)!,
    location: null, // PostGIS column not modeled in Drizzle
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    deletedAt: iso(row.deletedAt),
    isDraft: row.isDraft ?? false,
    moderationStatus: row.moderationStatus ?? null,
    moderatedAt: iso(row.moderatedAt),
    moderatedById: row.moderatedById ?? null,
    moderatedByType: row.moderatedByType ?? null,
    moderationReason: row.moderationReason ?? null,
  };
  if (opts.user !== undefined) entity.user = opts.user;
  if (opts.isSaved !== undefined) entity.isSaved = opts.isSaved;
  if (opts.files !== undefined) entity.files = opts.files;
  return entity;
}

/**
 * Batch-load the file associations (uploaded images/files) for a set of entities.
 * Returns a Map keyed by entityId; entities with no files are absent from the map.
 */
export async function loadEntityFiles(
  projectId: string,
  entityIds: (string | null | undefined)[]
): Promise<Map<string, ReturnType<typeof shapeFile>[]>> {
  const map = new Map<string, ReturnType<typeof shapeFile>[]>();
  const ids = [...new Set(entityIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.projectId, projectId), inArray(files.entityId, ids)));
  for (const r of rows.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (!r.entityId) continue;
    const arr = map.get(r.entityId) ?? [];
    arr.push(shapeFile(r));
    map.set(r.entityId, arr);
  }
  return map;
}

export function shapeComment(
  row: CommentRow,
  opts: { userReaction?: ReactionType | null; user?: User | null; parent?: Comment | null } = {}
): Comment {
  const deleted = !!row.userDeletedAt;
  const comment: Comment = {
    id: row.id,
    projectId: row.projectId,
    foreignId: row.foreignId ?? null,
    entityId: row.entityId,
    userId: row.userId ?? null,
    parentId: row.parentId ?? null,
    // Reddit-style placeholder: blank content/gif once the author deletes it.
    content: deleted ? null : row.content ?? null,
    gif: deleted ? null : row.gif ?? null,
    mentions: (row.mentions as unknown[]) ?? [],
    upvotes: row.upvotes ?? [],
    downvotes: row.downvotes ?? [],
    reactionCounts: row.reactionCounts as ReactionCounts,
    userReaction: opts.userReaction ?? null,
    repliesCount: row.repliesCount ?? 0,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    deletedAt: iso(row.deletedAt),
    userDeletedAt: iso(row.userDeletedAt),
    moderationStatus: row.moderationStatus ?? null,
    moderatedAt: iso(row.moderatedAt),
    moderatedById: row.moderatedById ?? null,
    moderatedByType: row.moderatedByType ?? null,
    moderationReason: row.moderationReason ?? null,
  };
  if (opts.user !== undefined) comment.user = opts.user;
  if (opts.parent !== undefined) comment.parentComment = opts.parent;
  return comment;
}

// ─── Request helpers ──────────────────────────────────────────────────────────

/** Parse a comma-separated ?include= list into a Set. */
export function parseInclude(c: Context): Set<string> {
  const raw = c.req.query("include");
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** URL-safe ~10-char short id for share links (entities.short_id). */
export function generateShortId(): string {
  return randomBytes(8).toString("base64url").slice(0, 10);
}

/**
 * Batch-fetch the auth user's reactions for a page of targets in one query.
 * Returns Map<targetId, reactionType> so list handlers enrich `userReaction` w/o N+1.
 */
export async function attachUserReactions(
  projectId: string,
  targetType: "entity" | "comment",
  targetIds: string[],
  userId: string | undefined
): Promise<Map<string, ReactionType>> {
  const map = new Map<string, ReactionType>();
  if (!userId || targetIds.length === 0) return map;
  const rows = await db
    .select({ targetId: reactions.targetId, reactionType: reactions.reactionType })
    .from(reactions)
    .where(
      and(
        eq(reactions.projectId, projectId),
        eq(reactions.targetType, targetType),
        eq(reactions.userId, userId),
        inArray(reactions.targetId, targetIds)
      )
    );
  for (const r of rows) map.set(r.targetId, r.reactionType as ReactionType);
  return map;
}

/** Batch-load shaped public Users by id (for ?include=user). */
export async function loadUsers(
  projectId: string,
  userIds: (string | null | undefined)[]
): Promise<Map<string, User>> {
  const map = new Map<string, User>();
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(profiles)
    .where(and(eq(profiles.projectId, projectId), inArray(profiles.id, ids)));
  for (const r of rows) {
    const u = shapeUser(r);
    if (u) map.set(r.id, u);
  }
  return map;
}

// ─── Space / membership / rule / collection / notification / report shapers ──

type SpaceRow = typeof spaces.$inferSelect;
type RuleRow = typeof spaceRules.$inferSelect;
type CollectionRow = typeof collections.$inferSelect;
type NotificationRow = typeof appNotifications.$inferSelect;
type ReportRow = typeof reports.$inferSelect;

export function shapeSpace(row: SpaceRow, opts: { isMember?: boolean } = {}) {
  const space = {
    id: row.id,
    projectId: row.projectId,
    shortId: row.shortId,
    slug: row.slug ?? null,
    name: row.name,
    description: row.description ?? null,
    avatarFileId: row.avatarFileId ?? null,
    bannerFileId: row.bannerFileId ?? null,
    userId: row.userId ?? null,
    readingPermission: row.readingPermission,
    postingPermission: row.postingPermission,
    requireJoinApproval: row.requireJoinApproval,
    parentSpaceId: row.parentSpaceId ?? null,
    depth: row.depth,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    membersCount: row.membersCount,
    childSpacesCount: row.childSpacesCount,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    deletedAt: iso(row.deletedAt),
  } as Record<string, unknown>;
  if (opts.isMember !== undefined) space.isMember = opts.isMember;
  return space;
}

export function shapeRule(row: RuleRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    spaceId: row.spaceId,
    title: row.title,
    description: row.description ?? null,
    order: row.order,
    lastApprovedBy: row.lastApprovedBy ?? null,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function shapeCollection(row: CollectionRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    parentId: row.parentId ?? null,
    name: row.name,
    entityCount: row.entityCount,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function shapeNotification(row: NotificationRow) {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    action: row.action ?? null,
    isRead: row.isRead,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: iso(row.createdAt)!,
  };
}

// AuthUser = UserFull minus secureMetadata, plus suspensions[] + authMethods[] (MODELS.md).
// Returned only to the authenticated user themselves (includes email/isVerified/lastActive).
// (interface imported + re-exported from @agora/contract at the top of this file)
export function shapeAuthUser(
  row: ProfileRow,
  suspensions: { reason: string | null; startDate: Date; endDate: Date | null }[] = []
): AuthUser {
  return {
    ...(shapeUser(row) as User),
    email: row.email ?? null,
    isVerified: row.isVerified,
    isActive: row.isActive,
    lastActive: iso(row.lastActive)!,
    updatedAt: iso(row.updatedAt)!,
    suspensions: suspensions.map((s) => ({
      reason: s.reason ?? null,
      startDate: iso(s.startDate)!,
      endDate: iso(s.endDate),
    })),
    authMethods: row.authMethods ?? [],
  };
}

export function shapeReport(row: ReportRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    reporterId: row.reporterId ?? null,
    targetType: row.targetType,
    targetId: row.targetId,
    spaceId: row.spaceId ?? null,
    reason: row.reason,
    details: row.details ?? null,
    resolvedAt: iso(row.resolvedAt),
    resolvedById: row.resolvedById ?? null,
    createdAt: iso(row.createdAt)!,
  };
}

// ─── file shaper ─────────────────────────────────────────────────────────────
type FileRow = typeof files.$inferSelect;

export function shapeFile(row: FileRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId ?? null,
    entityId: row.entityId ?? null,
    commentId: row.commentId ?? null,
    chatMessageId: row.chatMessageId ?? null,
    spaceId: row.spaceId ?? null,
    type: row.type,
    originalPath: row.originalPath,
    originalSize: row.originalSize,
    originalMimeType: row.originalMimeType ?? null,
    position: row.position,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    image: (row.image as Record<string, unknown>) ?? undefined,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

// ─── chat shapers ────────────────────────────────────────────────────────────
type ConversationRow = typeof conversations.$inferSelect;
type ConversationMemberRow = typeof conversationMembers.$inferSelect;
type ChatMessageRow = typeof chatMessages.$inferSelect;

export function shapeConversation(
  row: ConversationRow,
  opts: { unreadCount?: number; lastMessage?: unknown; currentMember?: unknown; memberCount?: number } = {}
) {
  const convo: Record<string, unknown> = {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    name: row.name ?? null,
    description: row.description ?? null,
    spaceId: row.spaceId ?? null,
    createdById: row.createdById ?? null,
    avatarFileId: row.avatarFileId ?? null,
    lastMessageAt: iso(row.lastMessageAt),
    postingPermission: row.postingPermission ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
  if (opts.memberCount !== undefined) convo.memberCount = opts.memberCount;
  if (opts.currentMember !== undefined) convo.currentMember = opts.currentMember;
  if (opts.unreadCount !== undefined) convo.unreadCount = opts.unreadCount;
  if (opts.lastMessage !== undefined) convo.lastMessage = opts.lastMessage;
  return convo;
}

export function shapeConversationMember(row: ConversationMemberRow, user?: User | null) {
  const m: Record<string, unknown> = {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    userId: row.userId,
    role: row.role ?? null,
    lastReadAt: iso(row.lastReadAt),
    mutedUntil: iso(row.mutedUntil),
    isActive: row.isActive,
    leftAt: iso(row.leftAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
  if (user !== undefined) m.user = user;
  return m;
}

export function shapeChatMessage(row: ChatMessageRow, opts: { userReactions?: string[]; user?: User | null; localId?: string; files?: unknown[] } = {}) {
  const deleted = !!row.userDeletedAt;
  const msg: Record<string, unknown> = {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    userId: row.userId ?? null,
    content: deleted ? null : row.content ?? null,
    gif: deleted ? null : row.gif ?? null,
    mentions: (row.mentions as unknown[]) ?? [],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    parentMessageId: row.parentMessageId ?? null,
    quotedMessageId: row.quotedMessageId ?? null,
    threadReplyCount: row.threadReplyCount,
    reactionCounts: (row.reactionCounts as Record<string, number>) ?? {},
    userReactions: opts.userReactions ?? [],
    editedAt: iso(row.editedAt),
    userDeletedAt: iso(row.userDeletedAt),
    moderationStatus: row.moderationStatus ?? null,
    moderatedAt: iso(row.moderatedAt),
    moderatedById: row.moderatedById ?? null,
    moderatedByType: row.moderatedByType ?? null,
    moderationReason: row.moderationReason ?? null,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
  if (opts.user !== undefined) msg.user = opts.user;
  if (opts.files !== undefined) msg.files = opts.files;
  // Echo the client's optimistic-message token so the SDK can reconcile (replace) its
  // optimistic placeholder by localId instead of rendering a duplicate. Transient — not persisted.
  if (opts.localId !== undefined) msg.localId = opts.localId;
  return msg;
}

/**
 * Batch-load the file associations (uploaded images/files) for a set of chat messages.
 * Returns a Map keyed by chatMessageId; messages with no files are absent from the map.
 */
export async function loadMessageFiles(
  projectId: string,
  messageIds: (string | null | undefined)[]
): Promise<Map<string, ReturnType<typeof shapeFile>[]>> {
  const map = new Map<string, ReturnType<typeof shapeFile>[]>();
  const ids = [...new Set(messageIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return map;
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.projectId, projectId), inArray(files.chatMessageId, ids)));
  for (const r of rows.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (!r.chatMessageId) continue;
    const arr = map.get(r.chatMessageId) ?? [];
    arr.push(shapeFile(r));
    map.set(r.chatMessageId, arr);
  }
  return map;
}
