// collections, collection_entities, files, app_notifications, reports, entity_embeddings (ex-0005)
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, bigint, doublePrecision, jsonb, timestamp, boolean, date, index, primaryKey, vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { reactionTarget, moderationVerdict } from "./_shared.js";
import { projects, profiles } from "./projects.js";
import { entities, comments } from "./content.js";
import { spaces } from "./spaces.js";
import { chatMessages } from "./chat.js";

export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => collections.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  entityCount: integer("entity_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("collections_user_idx").on(t.projectId, t.userId, t.parentId),
]);

export const collectionEntities = pgTable("collection_entities", {
  collectionId: uuid("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  entityId: uuid("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.collectionId, t.entityId] }),
]);

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => profiles.id, { onDelete: "set null" }),
  entityId: uuid("entity_id").references(() => entities.id, { onDelete: "cascade" }),
  commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
  chatMessageId: uuid("chat_message_id").references(() => chatMessages.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  originalPath: text("original_path").notNull(),
  originalSize: bigint("original_size", { mode: "number" }).notNull().default(0),
  originalMimeType: text("original_mime_type"),
  position: integer("position").notNull().default(0),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  image: jsonb("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("files_entity_idx").on(t.entityId),
  index("files_comment_idx").on(t.commentId),
  index("files_chat_idx").on(t.chatMessageId),
]);

export const appNotifications = pgTable("app_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  action: text("action"),
  isRead: boolean("is_read").notNull().default(false),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("app_notifications_inbox_idx").on(t.projectId, t.userId, t.isRead, t.createdAt.desc()),
]);

export const reports = pgTable("reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  reporterId: uuid("reporter_id").references(() => profiles.id, { onDelete: "set null" }),
  targetType: reactionTarget("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  details: text("details"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedById: uuid("resolved_by_id").references(() => profiles.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("reports_queue_idx").on(t.projectId, t.spaceId, t.resolvedAt),
  index("reports_target_idx").on(t.targetType, t.targetId),
]);

// Automated-moderation audit trail (@agora/moderator). One row per LLM assessment: the verdict, the
// reason, and whether the moderator auto-acted (wrote a removal back to the API). The DDL lives here
// because apps/api owns the schema (single source of truth); the moderator service binds a thin copy
// for its reads/writes. `humanResolvedAt` clears an item from the admin AI-flag queue once a human
// dispositions it. targetType reuses reaction_target (entity|comment|message).
export const moderationAnalyses = pgTable("moderation_analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  targetType: reactionTarget("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
  verdict: moderationVerdict("verdict").notNull(),
  categories: text("categories").array().notNull().default(sql`'{}'`),
  confidence: doublePrecision("confidence").notNull().default(0),
  reason: text("reason").notNull().default(""),
  model: text("model").notNull().default(""),
  autoActioned: boolean("auto_actioned").notNull().default(false),
  humanResolvedAt: timestamp("human_resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // The admin AI-flag queue: unresolved analyses for a project, optionally scoped to a space.
  index("moderation_analyses_queue_idx").on(t.projectId, t.spaceId, t.humanResolvedAt),
  // Look up the latest analysis for a specific piece of content.
  index("moderation_analyses_target_idx").on(t.targetType, t.targetId),
]);

export const entityEmbeddings = pgTable("entity_embeddings", {
  entityId: uuid("entity_id").primaryKey().references(() => entities.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 1024 }), // Voyage voyage-3.5 @ 1024
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Generic content embeddings across source types (entity | comment | message) for semantic
// search. source_id is the row's uuid in its own table; we don't FK it (it spans 3 tables) —
// match_content filters out soft-deleted/missing rows at query time. The ivfflat index on
// `embedding` is added in a custom migration (extension op). Cascades on project delete.
export const contentEmbeddings = pgTable("content_embeddings", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(), // "entity" | "comment" | "message"
  sourceId: uuid("source_id").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.sourceType, t.sourceId] }),
  index("content_embeddings_project_idx").on(t.projectId),
]);

// Per-project, per-month request metering for the admin dashboard "App metering" cards. Written by
// middleware/metrics.ts via an additive upsert (in-memory aggregation flushed periodically), so it
// stays one row per project per month and concurrent API replicas increment safely.
// Avg latency = duration_ms_total / requests. Egress is uncompressed response-body bytes
// (Content-Length) — a "logical" client-egress figure (pre-gzip at the proxy).
export const apiUsage = pgTable("api_usage", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  month: date("month").notNull(), // first day of the month (UTC)
  requests: bigint("requests", { mode: "number" }).notNull().default(0),
  egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
  durationMsTotal: bigint("duration_ms_total", { mode: "number" }).notNull().default(0),
  errors: bigint("errors", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.month] }),
]);
