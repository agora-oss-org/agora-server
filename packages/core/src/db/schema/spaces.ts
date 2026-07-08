// spaces, space_members, space_rules, follows, connections (ex-0003)
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, unique, check, primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  readingPermission, postingPermission, spaceMemberRole, spaceMemberStatus, connectionStatus, spaceVisibility,
} from "./_shared.js";
import { projects, profiles } from "./projects.js";

export const spaces = pgTable("spaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  shortId: text("short_id").notNull(),
  slug: text("slug"),
  name: text("name").notNull(),
  description: text("description"),
  avatarFileId: uuid("avatar_file_id"),
  bannerFileId: uuid("banner_file_id"),
  userId: uuid("user_id").references(() => profiles.id, { onDelete: "set null" }),
  readingPermission: readingPermission("reading_permission").notNull().default("anyone"),
  postingPermission: postingPermission("posting_permission").notNull().default("members"),
  visibility: spaceVisibility("visibility").notNull().default("public"),
  requireJoinApproval: boolean("require_join_approval").notNull().default(false),
  parentSpaceId: uuid("parent_space_id").references((): AnyPgColumn => spaces.id, { onDelete: "cascade" }),
  depth: integer("depth").notNull().default(0),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  membersCount: integer("members_count").notNull().default(0),
  childSpacesCount: integer("child_spaces_count").notNull().default(0),
  digestEnabled: boolean("digest_enabled").notNull().default(false),
  // Per-space read-receipts opt-in (corporate tier, docs/SOCIAL-GRAPH.md §4). Flipped ONLY by the
  // operator endpoint (PATCH /admin/social/read-receipts/spaces/:id); deliberately not in the member
  // space-update schema. Gates whether reads in this space are recorded into read_receipts.
  readReceiptsEnabled: boolean("read_receipts_enabled").notNull().default(false),
  digestWebhookUrl: text("digest_webhook_url"),
  digestWebhookSecret: text("digest_webhook_secret"),
  digestScheduleHour: integer("digest_schedule_hour"),
  digestTimezone: text("digest_timezone"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  unique("spaces_project_short").on(t.projectId, t.shortId),
  unique("spaces_project_slug").on(t.projectId, t.slug),
  index("spaces_parent_idx").on(t.projectId, t.parentSpaceId),
]);

export const spaceMembers = pgTable("space_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  role: spaceMemberRole("role").notNull().default("member"),
  status: spaceMemberStatus("status").notNull().default("active"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("space_members_unique").on(t.spaceId, t.userId),
  index("space_members_status_idx").on(t.spaceId, t.status),
  index("space_members_user_idx").on(t.userId),
]);

// Per-(user, space) reputation — the space-partitioned twin of profiles.reputation.
// Trigger-maintained (see drizzle/0059); composite PK is the upsert conflict target.
export const spaceReputation = pgTable("space_reputation", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  reputation: integer("reputation").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.spaceId, t.userId] }),
  index("space_reputation_user_idx").on(t.projectId, t.userId),
]);

export const spaceRules = pgTable("space_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  order: integer("order").notNull().default(0),
  lastApprovedBy: uuid("last_approved_by").references(() => profiles.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("space_rules_order_idx").on(t.spaceId, t.order),
]);

export const follows = pgTable("follows", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  followerId: uuid("follower_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  followedId: uuid("followed_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("follows_unique").on(t.projectId, t.followerId, t.followedId),
  index("follows_followed_idx").on(t.followedId),
  index("follows_follower_idx").on(t.followerId),
  check("follows_no_self", sql`${t.followerId} <> ${t.followedId}`),
]);

export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  requesterId: uuid("requester_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  addresseeId: uuid("addressee_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  status: connectionStatus("status").notNull().default("pending"),
  message: text("message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
}, (t) => [
  unique("connections_unique").on(t.projectId, t.requesterId, t.addresseeId),
  index("connections_addressee_idx").on(t.projectId, t.addresseeId, t.status),
  index("connections_requester_idx").on(t.projectId, t.requesterId, t.status),
  check("connections_no_self", sql`${t.requesterId} <> ${t.addresseeId}`),
]);
