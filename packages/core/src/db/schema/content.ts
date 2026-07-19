// entities, comments, reactions (ex-0002). Denormalized counts maintained by triggers.
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, boolean, doublePrecision, jsonb, timestamp, index, unique, primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  reactionType, reactionTarget, moderationStatus, moderatedByType, zeroReactionCounts,
} from "./_shared.js";
import { projects, profiles } from "./projects.js";
import { spaces } from "./spaces.js";

export const entities = pgTable("entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  foreignId: text("foreign_id"),
  shortId: text("short_id").notNull(),
  sourceId: text("source_id"),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "set null" }),
  userId: uuid("user_id").references(() => profiles.id, { onDelete: "set null" }),
  title: text("title"),
  content: text("content"),
  mentions: jsonb("mentions").notNull().default(sql`'[]'::jsonb`),
  attachments: jsonb("attachments").notNull().default(sql`'[]'::jsonb`),
  keywords: text("keywords").array().notNull().default(sql`'{}'`),
  upvotes: text("upvotes").array().notNull().default(sql`'{}'`),       // v6 legacy
  downvotes: text("downvotes").array().notNull().default(sql`'{}'`),   // v6 legacy
  reactionCounts: jsonb("reaction_counts").notNull().default(zeroReactionCounts),
  repliesCount: integer("replies_count").notNull().default(0),
  views: integer("views").notNull().default(0),
  score: doublePrecision("score").notNull().default(0),
  scoreUpdatedAt: timestamp("score_updated_at", { withTimezone: true }).defaultNow().notNull(),
  // location geography(Point,4326) added in custom migration 0001_postgis
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  isDraft: boolean("is_draft").default(false),
  // Internet-public flag — the top rung of the visibility ladder (anonymous /public/* surface).
  // Ladder-validated on write (only community-public content may be flagged); the read gate
  // re-derives `isPublic AND space-is-public` live, so a stale true is harmless (fail closed).
  isPublic: boolean("is_public").notNull().default(false),
  moderationStatus: moderationStatus("moderation_status"),
  moderatedAt: timestamp("moderated_at", { withTimezone: true }),
  moderatedById: uuid("moderated_by_id").references(() => profiles.id, { onDelete: "set null" }),
  moderatedByType: moderatedByType("moderated_by_type"),
  moderationReason: text("moderation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  unique("entities_project_short").on(t.projectId, t.shortId),
  unique("entities_project_foreign").on(t.projectId, t.foreignId),
  index("entities_feed_score_idx").on(t.projectId, t.spaceId, t.score.desc()),
  index("entities_feed_new_idx").on(t.projectId, t.spaceId, t.createdAt.desc()),
  index("entities_user_idx").on(t.projectId, t.userId),
]);

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  foreignId: text("foreign_id"),
  entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => profiles.id, { onDelete: "set null" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
  content: text("content"),
  gif: jsonb("gif"),
  mentions: jsonb("mentions").notNull().default(sql`'[]'::jsonb`),
  upvotes: text("upvotes").array().notNull().default(sql`'{}'`),       // v6 legacy
  downvotes: text("downvotes").array().notNull().default(sql`'{}'`),   // v6 legacy
  reactionCounts: jsonb("reaction_counts").notNull().default(zeroReactionCounts),
  repliesCount: integer("replies_count").notNull().default(0),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  moderationStatus: moderationStatus("moderation_status"),
  moderatedAt: timestamp("moderated_at", { withTimezone: true }),
  moderatedById: uuid("moderated_by_id").references(() => profiles.id, { onDelete: "set null" }),
  moderatedByType: moderatedByType("moderated_by_type"),
  moderationReason: text("moderation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  userDeletedAt: timestamp("user_deleted_at", { withTimezone: true }),
}, (t) => [
  index("comments_thread_idx").on(t.projectId, t.entityId, t.parentId, t.createdAt),
  index("comments_parent_idx").on(t.parentId),
  index("comments_user_idx").on(t.userId),
]);

export const reactions = pgTable("reactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  targetType: reactionTarget("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  reactionType: reactionType("reaction_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("reactions_unique").on(t.projectId, t.targetType, t.targetId, t.userId),
  index("reactions_target_idx").on(t.targetType, t.targetId),
  index("reactions_user_idx").on(t.userId),
]);

// Per-space read receipts (corporate tier, docs/SOCIAL-GRAPH.md §4). One row per (entity, member) read,
// recorded ONLY for entities in a read-receipts-enabled space. Pure Postgres — NEVER written to Neo4j or
// the social graph; queryable only by the operator (coverage). spaceId is denormalized (captured at read
// time) so coverage rollups don't re-join entities. Idempotent: the (project, entity, user) PK upserts,
// bumping readAt on a re-read. RLS deny-all is added in the custom migration (0017 doesn't cover new tables).
export const readReceipts = pgTable("read_receipts", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  readAt: timestamp("read_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.entityId, t.userId] }),
  index("read_receipts_space_idx").on(t.projectId, t.spaceId),
]);
