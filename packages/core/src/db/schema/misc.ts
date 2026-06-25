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

// Generic per-project custom-table rows (the SDK's `/db/:tableName` surface). Schemaless `data`
// jsonb; `user_id` is the per-row owner (set-null on profile delete). `deleted_at` = soft-delete.
export const tableRows = pgTable("table_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  tableName: text("table_name").notNull(),
  userId: uuid("user_id").references(() => profiles.id, { onDelete: "set null" }),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("table_rows_lookup_idx").on(t.projectId, t.tableName, t.userId),
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

// Automated-moderation audit trail (services/scorer). One row per LLM assessment: the verdict, the
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
  // LLM token usage for this assessment (provider-reported; 0 when the host omits usage). Summed for
  // the admin dashboard's automated-moderation metrics.
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
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

// Durable "needs embedding" flag (lib/embed-throttle.ts / lib/pending-embeddings.ts). When the outbound
// embed throttle trips for a project, write-path embeds that get skipped land here instead of silently
// dropping, and the drain cron (/internal/cron/drain-embeddings) replays them into content_embeddings
// once the breaker reopens. PK mirrors content_embeddings' (source_type, source_id) so each item dedups
// (latest text wins if the row was edited while paused). `text` is the resolved embed input captured at
// enqueue, deleted on drain. RLS deny-all (shipped in the creating migration — 0017 was one-time).
export const pendingEmbeddings = pgTable("pending_embeddings", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(), // "entity" | "comment" | "message"
  sourceId: uuid("source_id").notNull(),
  text: text("text").notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.sourceType, t.sourceId] }),
  index("pending_embeddings_drain_idx").on(t.projectId, t.createdAt),
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

// Hourly community-activity rollup powering the operator-only "Community" dashboard. One row per
// (project_id, hour), written by the community-stats cron (lib/community-stats.ts) via an idempotent
// upsert that recomputes a trailing window each run (so a missed run self-heals). Mirrors api_usage's
// one-row-per-bucket convention. Three groups of columns:
//   • flow        — events that happened WITHIN the hour (new_*, active_* distinct actors, reports)
//   • cumulative  — all-time totals as of the END of the hour (total_*), for pulse cards + 24h deltas
//                   without summing history
//   • snapshots   — the leaderboard / top-post ranking over the rolling window, as of this hour. We
//                   store ids + counts ONLY; display fields (username/avatar/title) are hydrated
//                   fresh at read time so renames/edits never go stale. Past rows keep their history.
export const communityStatsHourly = pgTable("community_stats_hourly", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  hour: timestamp("hour", { withTimezone: true }).notNull(), // hour boundary (UTC, date_trunc('hour'))
  newUsers: integer("new_users").notNull().default(0),
  newPosts: integer("new_posts").notNull().default(0),
  newComments: integer("new_comments").notNull().default(0),
  newReactions: integer("new_reactions").notNull().default(0),
  activePosters: integer("active_posters").notNull().default(0),
  activeCommenters: integer("active_commenters").notNull().default(0),
  activeReactors: integer("active_reactors").notNull().default(0),
  reportsOpened: integer("reports_opened").notNull().default(0),
  reportsResolved: integer("reports_resolved").notNull().default(0),
  totalUsers: integer("total_users").notNull().default(0),
  totalPosts: integer("total_posts").notNull().default(0),
  totalComments: integer("total_comments").notNull().default(0),
  totalReactions: integer("total_reactions").notNull().default(0),
  topPosters: jsonb("top_posters").notNull().default(sql`'[]'::jsonb`),       // [{ userId, count }]
  topCommenters: jsonb("top_commenters").notNull().default(sql`'[]'::jsonb`), // [{ userId, count }]
  topReactors: jsonb("top_reactors").notNull().default(sql`'[]'::jsonb`),     // [{ userId, count }]
  topPosts: jsonb("top_posts").notNull().default(sql`'[]'::jsonb`),           // [{ entityId, reactions, replies, score }]
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.hour] }),
]);

// Constellation snapshot (docs/AGORA-SOCIAL.md §12) — the anonymous community *shape*, materialized on a
// slow seasonal cadence by POST /internal/cron/social-constellation (never per-load — §12). One row per
// (project, snapshot epoch); the read endpoint serves the LATEST row. `blobs` is the rendered, already
// k-anonymized + bucketed output ([{ size, warmth }]) — no member ids, no cluster identity (re-clustered
// fresh each epoch). `method` records which clustering produced it (GDS Louvain or the by-space fallback).
export const socialConstellation = pgTable("social_constellation", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(), // snapshot epoch boundary
  method: text("method").notNull(),                                       // 'louvain' | 'space'
  blobs: jsonb("blobs").notNull().default(sql`'[]'::jsonb`),              // [{ size: bucket, warmth: band }]
  memberCount: integer("member_count").notNull().default(0),              // total clustered members (pre-suppression)
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.computedAt] }),
]);

// Admin analytics snapshots (docs/AGORA-CORP.md; docs/SOCIAL-GRAPH.md §7 Phase 4) — the operator-only,
// NAMED corporate reports, materialized on a slow (weekly) cadence by POST /internal/cron/social-analytics
// plus an operator-forced recompute. ONE combined table: `report` discriminates influence | silos |
// engagement, one row per (project, report, snapshot epoch). The read endpoints serve the LATEST row
// (engagement also reads a trailing window for the churn-risk trend). `payload` stores RAW ids + scores
// only (no names) — names are hydrated fresh at read so they never go stale. Corporate-tier-only, gated
// per report by its CORPORATE_ONLY_FLAG.
export const socialAnalytics = pgTable("social_analytics", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  report: text("report").notNull(),                                       // 'influence' | 'silos' | 'engagement'
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(), // snapshot epoch boundary
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),          // raw ids + scores (names hydrated at read)
  memberCount: integer("member_count").notNull().default(0),              // people scored in this snapshot
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.report, t.computedAt] }),
]);
