// conversations, conversation_members, chat_messages, chat_message_reactions (ex-0004)
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, unique, check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { conversationType, convMemberRole, moderationStatus, moderatedByType } from "./_shared.js";
import { projects, profiles } from "./projects.js";
import { spaces } from "./spaces.js";
import { stewardCases } from "./steward.js";

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  type: conversationType("type").notNull(),
  name: text("name"),
  description: text("description"),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
  // Set when this conversation is a steward mediation channel (caucus or joint). The role + caucus party
  // live in metadata.mediation = { role: 'caucus'|'joint', party? }. See lib/mediation.ts.
  stewardCaseId: uuid("steward_case_id").references(() => stewardCases.id, { onDelete: "set null" }),
  createdById: uuid("created_by_id").references(() => profiles.id, { onDelete: "set null" }),
  avatarFileId: uuid("avatar_file_id"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  postingPermission: text("posting_permission"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("conversations_recent_idx").on(t.projectId, t.lastMessageAt.desc()),
  index("conversations_space_idx").on(t.spaceId),
  index("conversations_steward_case_idx").on(t.stewardCaseId),
  check("conversations_posting_perm", sql`${t.postingPermission} in ('members','admins')`),
]);

export const conversationMembers = pgTable("conversation_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  role: convMemberRole("role"),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  mutedUntil: timestamp("muted_until", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  leftAt: timestamp("left_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("conversation_members_unique").on(t.conversationId, t.userId),
  index("conversation_members_user_idx").on(t.userId, t.isActive),
]);

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => profiles.id, { onDelete: "set null" }),
  content: text("content"),
  gif: jsonb("gif"),
  mentions: jsonb("mentions").notNull().default(sql`'[]'::jsonb`),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  parentMessageId: uuid("parent_message_id").references((): AnyPgColumn => chatMessages.id, { onDelete: "set null" }),
  quotedMessageId: uuid("quoted_message_id").references((): AnyPgColumn => chatMessages.id, { onDelete: "set null" }),
  threadReplyCount: integer("thread_reply_count").notNull().default(0),
  reactionCounts: jsonb("reaction_counts").notNull().default(sql`'{}'::jsonb`),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  userDeletedAt: timestamp("user_deleted_at", { withTimezone: true }),
  moderationStatus: moderationStatus("moderation_status"),
  moderatedAt: timestamp("moderated_at", { withTimezone: true }),
  moderatedById: uuid("moderated_by_id").references(() => profiles.id, { onDelete: "set null" }),
  moderatedByType: moderatedByType("moderated_by_type"),
  moderationReason: text("moderation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("chat_messages_recent_idx").on(t.conversationId, t.createdAt.desc()),
  index("chat_messages_parent_idx").on(t.parentMessageId),
]);

export const chatMessageReactions = pgTable("chat_message_reactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  emoji: text("emoji").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("chat_message_reactions_unique").on(t.messageId, t.userId, t.emoji),
  index("chat_message_reactions_msg_idx").on(t.messageId),
]);
