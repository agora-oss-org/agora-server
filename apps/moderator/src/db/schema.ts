// Thin Drizzle bindings for the moderator service. This is an INTENTIONAL, documented mirror of
// just the columns the moderator touches — the authoritative DDL (and migrations) live in
// apps/api/src/db/schema (the single source of truth per CLAUDE.md). The moderator only:
//   - READS  projects.webhook_secret (to verify inbound webhook signatures)
//   - R/W    moderation_analyses (its own audit-trail + AI-flag queue table)
// All content mutations go through the API over HTTP — the moderator never writes entities/comments.
import { pgTable, uuid, text, doublePrecision, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Must match apps/api/src/db/schema/_shared.ts exactly (Drizzle references existing PG types by name).
export const reactionTarget = pgEnum("reaction_target", ["entity", "comment", "message"]);
export const moderationVerdict = pgEnum("moderation_verdict", ["allow", "block", "review"]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  webhookSecret: text("webhook_secret"),
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
  humanResolvedAt: timestamp("human_resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
