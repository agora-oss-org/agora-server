// projects, project_integrations, profiles, user_suspensions, oauth_identities (ex-0001)
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, boolean, date, jsonb, timestamp, index, unique, check,
} from "drizzle-orm/pg-core";
import { userRole, authProvider } from "./_shared.js";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull(),
  name: text("name").notNull(),
  externalAuthPublicKey: text("external_auth_public_key"),
  // Project webhooks (Replyke-style): one URL + shared secret + the events opted into.
  // Validation events (e.g. "entity.created") block the op; broadcast events ("*.complete") notify.
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),
  webhookEvents: text("webhook_events").array().notNull().default(sql`'{}'`),
  // Per-project moderator tuning the services/scorer subsystem overlays on its own env defaults:
  // `blockAutoActionThreshold` + `reviewAutoActionThreshold` (0..1 auto-remove cutoffs) + LLM
  // provider config (`llmProvider`, `llmBaseUrl`, `llmApiKey`, `llmModel`, `llmMaxTokens`). Any unset key falls back to the
  // scorer's env. Edited via admin Settings → Moderator; `llmApiKey` is write-only in the view.
  moderatorConfig: jsonb("moderator_config").notNull().default(sql`'{}'::jsonb`),
  // Per-project feed ranking config (algorithm + tunables + optional re-rank webhook). See
  // lib/feed-config.ts for the resolved shape + defaults; backs the admin Feed settings UI.
  feedConfig: jsonb("feed_config").notNull().default(sql`'{}'::jsonb`),
  // Deprecated/unused: once held `removedContentBehavior` (hide vs placeholder). Removed content is
  // now ALWAYS hidden (filtered out / 404 for non-moderators) — see lib/moderation-visibility.ts.
  // Column kept to avoid a migration; safe to drop later.
  moderationConfig: jsonb("moderation_config").notNull().default(sql`'{}'::jsonb`),
  // Steward (conflict-resolution) tuning. Currently `{ notifyPolicy }` — who gets notified about a case
  // (power-aware | symmetric | resolution-only). Resolved via lib/steward-config.ts; edited in admin
  // Settings → Stewardship. Empty = the power-aware default.
  stewardConfig: jsonb("steward_config").notNull().default(sql`'{}'::jsonb`),
  // Per-project social-graph config: the community↔corporate privacy tier + feature flags
  // (docs/SOCIAL-GRAPH.md §5, docs/AGORA-CORP.md §4). Resolved via lib/social-config.ts
  // (tier defaults + clamp, fail-closed); edited in admin Settings → Social Graph. Empty = community defaults.
  socialConfig: jsonb("social_config").notNull().default(sql`'{}'::jsonb`),
  // Identity backend for this project. "supabase" delegates to Supabase Auth (default, existing behaviour);
  // "native" uses Agora's own credential store (auth_credentials + auth_email_tokens).
  authProvider: authProvider("auth_provider").notNull().default("supabase"),
  // How a confirmed self-service account deletion is applied: hard (remove identity, keep authored
  // content authorless) | soft (disable the auth user, keep the profile) | ban (reversible disable).
  accountDeletionMode: text("account_deletion_mode").notNull().default("hard"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const projectIntegrations = pgTable("project_integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  authUserId: uuid("auth_user_id"),   // links to Supabase auth.users; FK enforced by app, not Drizzle
  foreignId: text("foreign_id"),
  role: userRole("role").notNull().default("visitor"),
  email: text("email"),
  name: text("name"),
  username: text("username"),
  avatar: text("avatar"),
  avatarFileId: uuid("avatar_file_id"),
  bannerFileId: uuid("banner_file_id"),
  bio: text("bio"),
  birthdate: date("birthdate"),
  // location geography(Point,4326) added in custom migration 0001_postgis
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  secureMetadata: jsonb("secure_metadata").notNull().default(sql`'{}'::jsonb`),
  reputation: integer("reputation").notNull().default(0),
  isVerified: boolean("is_verified").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  lastActive: timestamp("last_active", { withTimezone: true }).defaultNow().notNull(),
  authMethods: text("auth_methods").array().notNull().default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("profiles_project_username").on(t.projectId, t.username),
  unique("profiles_project_foreign").on(t.projectId, t.foreignId),
  index("profiles_project_username_idx").on(t.projectId, t.username),
  index("profiles_project_foreign_idx").on(t.projectId, t.foreignId),
  check("profiles_bio_len", sql`char_length(${t.bio}) <= 300`),
]);

export const userSuspensions = pgTable("user_suspensions", {
  id: uuid("id").primaryKey().defaultRandom(),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  reason: text("reason"),
  startDate: timestamp("start_date", { withTimezone: true }).defaultNow().notNull(),
  endDate: timestamp("end_date", { withTimezone: true }),
}, (t) => [
  // Per-request suspension enforcement looks this up by profile on every authed request.
  index("user_suspensions_profile_idx").on(t.profileId),
]);

export const oauthIdentities = pgTable("oauth_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerUid: text("provider_uid").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("oauth_identity_unique").on(t.projectId, t.provider, t.providerUid),
]);

// Short-lived correlation rows for the OAuth code+PKCE flow: created in /oauth/authorize, read
// (and deleted) in /oauth/callback. Holds the Supabase PKCE verifier + where to redirect back to.
// profileId is set only for the link flow (plain uuid — no FK; the row is ephemeral).
export const oauthStates = pgTable("oauth_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id"),
  provider: text("provider").notNull(),
  flow: text("flow").notNull(), // "signin" | "link"
  redirectAfterAuth: text("redirect_after_auth").notNull(),
  pkce: jsonb("pkce").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("oauth_states_created_idx").on(t.createdAt),
]);
