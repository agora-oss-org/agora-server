// events, event_rsvps, event_invites, event_hosts (SDK v7.6.2 Events domain).
// NOTE: `location` geography(Point,4326) + its GiST index are added in the custom SQL migration
// (Drizzle's customType mis-quotes the geography modifier — same as entities/profiles).
// `space_id` is a SOFT reference (no FK) per the SDK contract. rsvp_counts + host_ids are DERIVED
// (computed per request), not stored.
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, unique, primaryKey } from "drizzle-orm/pg-core";
import { eventType, eventVisibility, eventStatus, rsvpStatus, moderationStatus, moderatedByType } from "./_shared.js";
import { projects, profiles } from "./projects.js";

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  shortId: text("short_id").notNull(),
  userId: uuid("user_id").references(() => profiles.id, { onDelete: "set null" }), // creator
  title: text("title").notNull(),
  description: text("description"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }),
  timezone: text("timezone"),
  type: eventType("type").notNull(),
  url: text("url"),
  venueName: text("venue_name"),
  address: text("address"),
  spaceId: uuid("space_id"), // SOFT ref — no FK
  visibility: eventVisibility("visibility").notNull().default("public"),
  status: eventStatus("status").notNull().default("active"),
  allowMaybe: boolean("allow_maybe").notNull().default(true),
  guestListVisible: boolean("guest_list_visible").notNull().default(true),
  capacity: integer("capacity"), // null = unlimited
  coverImageId: uuid("cover_image_id"), // a files.id (no FK — avoids a cycle with files.event_id)
  // location geography(Point,4326) added in the custom events migration
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  moderationStatus: moderationStatus("moderation_status"),
  moderatedAt: timestamp("moderated_at", { withTimezone: true }),
  moderatedById: uuid("moderated_by_id").references(() => profiles.id, { onDelete: "set null" }),
  moderatedByType: moderatedByType("moderated_by_type"),
  moderationReason: text("moderation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  unique("events_project_short").on(t.projectId, t.shortId),
  index("events_feed_idx").on(t.projectId, t.startTime),
  index("events_space_idx").on(t.projectId, t.spaceId),
]);

export const eventRsvps = pgTable("event_rsvps", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  status: rsvpStatus("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("event_rsvps_unique").on(t.eventId, t.userId),
  index("event_rsvps_event_idx").on(t.eventId, t.status),
]);

export const eventInvites = pgTable("event_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  // `invitedAt` and `createdAt` are intentionally both present (not accidental redundancy): the SDK
  // contract's EventInvite exposes both fields (see packages/contract EventInvite + MODELS.md), so
  // shapeEventInvite emits both. Keep them — dropping `invited_at` would be a wire-contract break.
  invitedAt: timestamp("invited_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("event_invites_unique").on(t.eventId, t.userId),
]);

export const eventHosts = pgTable("event_hosts", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.eventId, t.userId] }),
  index("event_hosts_user_idx").on(t.projectId, t.userId),
]);
