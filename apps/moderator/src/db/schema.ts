// Thin Drizzle bindings for the moderator service. This is an INTENTIONAL, documented mirror of
// just the columns the moderator touches — the authoritative DDL (and migrations) live in
// apps/api/src/db/schema (the single source of truth per CLAUDE.md). The moderator only:
//   - READS  projects.moderation_webhook_secret (to verify inbound webhook signatures; falls back
//            to webhook_secret for projects that haven't set a dedicated moderation secret)
//   - R/W    moderation_analyses (its own audit-trail + AI-flag queue table)
// All content mutations go through the API over HTTP — the moderator never writes entities/comments.
import { pgTable, uuid, text, integer, doublePrecision, boolean, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Must match apps/api/src/db/schema/_shared.ts exactly (Drizzle references existing PG types by name).
export const reactionTarget = pgEnum("reaction_target", ["entity", "comment", "message"]);
export const moderationVerdict = pgEnum("moderation_verdict", ["allow", "block", "review"]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  webhookSecret: text("webhook_secret"),
  moderationWebhookSecret: text("moderation_webhook_secret"),
  // Per-project tuning the moderator overlays on its env defaults (block/review auto-action thresholds + LLM config).
  // Authored by the API (admin Settings → Moderator); read here via lib/project-config.ts.
  moderatorConfig: jsonb("moderator_config").notNull().default(sql`'{}'::jsonb`),
});

// Read-only mirrors of just the columns the queue needs to resolve a flagged item's author (poster):
// target → userId (entities/comments) → profile name. Authoritative DDL lives in apps/api.
export const entities = pgTable("entities", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id"),
});
export const comments = pgTable("comments", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id"),
});
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  username: text("username"),
  name: text("name"),
});

export const moderationAnalyses = pgTable("moderation_analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  targetType: reactionTarget("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  spaceId: uuid("space_id"),
  verdict: moderationVerdict("verdict").notNull(),
  categories: text("categories").array().notNull().default(sql`'{}'`),
  confidence: doublePrecision("confidence").notNull().default(0),
  reason: text("reason").notNull().default(""),
  model: text("model").notNull().default(""),
  autoActioned: boolean("auto_actioned").notNull().default(false),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  humanResolvedAt: timestamp("human_resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
