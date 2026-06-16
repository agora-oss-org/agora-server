// refresh_tokens — powers Agora's token rotation + reuse detection.
// A login starts a "family"; each refresh rotates the token within the family. Replaying a
// spent token (outside the 30s grace) implies theft → the whole family is revoked.
import { pgTable, uuid, text, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { projects, profiles } from "./projects.js";
import { authEmailTokenKind } from "./_shared.js";

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").notNull(),       // groups one login session's rotation chain
  tokenHash: text("token_hash").notNull(),     // sha256(raw token); raw is never stored
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }), // set when this token mints a successor
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("refresh_tokens_hash_idx").on(t.tokenHash),
  index("refresh_tokens_family_idx").on(t.familyId),
  index("refresh_tokens_profile_idx").on(t.profileId),
]);

// auth_credentials — Agora-native email+password store (only used when projects.auth_provider='native').
// One row per (project, email) — the unique constraint enforces this.
// Email is stored lowercased at write time (app code), so no citext needed.
export const authCredentials = pgTable("auth_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  emailConfirmedAt: timestamp("email_confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("auth_credentials_project_email").on(t.projectId, t.email),
]);

// auth_email_tokens — short-lived hashed tokens for email confirmation + password reset.
// tokenHash is sha256(rawToken); the raw token is only ever sent to the user, never stored.
export const authEmailTokens = pgTable("auth_email_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  credentialId: uuid("credential_id").notNull().references(() => authCredentials.id, { onDelete: "cascade" }),
  kind: authEmailTokenKind("kind").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("auth_email_tokens_hash_idx").on(t.tokenHash),
  index("auth_email_tokens_credential_idx").on(t.credentialId),
]);
