// Shared building blocks: enums and reusable column defaults.
// NOTE: PostGIS `geography(Point,4326)` location columns + their GiST indexes are added
// in a custom SQL migration (Drizzle's customType mis-quotes the type modifier), and
// auth.users (Supabase-managed) is intentionally NOT modeled here — `profiles.auth_user_id`
// is a plain uuid the app links, so Drizzle never tries to own the auth schema.
import { pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Enums (mirror @replyke/core types) ──────────────────────────────────────
export const userRole = pgEnum("user_role", ["admin", "moderator", "visitor"]);
export const reactionType = pgEnum("reaction_type", ["upvote", "downvote", "like", "love", "wow", "sad", "angry", "funny"]);
// "message" is used by reports (chat-message reports); reactions only ever use entity|comment.
export const reactionTarget = pgEnum("reaction_target", ["entity", "comment", "message"]);
export const moderationStatus = pgEnum("moderation_status", ["approved", "removed"]);
export const moderatedByType = pgEnum("moderated_by_type", ["client", "user"]);
export const readingPermission = pgEnum("reading_permission", ["anyone", "members"]);
export const postingPermission = pgEnum("posting_permission", ["anyone", "members", "admins"]);
export const spaceMemberRole = pgEnum("space_member_role", ["admin", "moderator", "member"]);
export const spaceMemberStatus = pgEnum("space_member_status", ["pending", "active", "banned", "rejected"]);
export const conversationType = pgEnum("conversation_type", ["direct", "group", "space"]);
export const convMemberRole = pgEnum("conv_member_role", ["admin", "member"]);
export const connectionStatus = pgEnum("connection_status", ["pending", "connected", "declined"]);

// ─── Reusable jsonb default: the 8 v7 reaction counts, all zero ──────────────
export const zeroReactionCounts = sql`'{"upvote":0,"downvote":0,"like":0,"love":0,"wow":0,"sad":0,"angry":0,"funny":0}'::jsonb`;
