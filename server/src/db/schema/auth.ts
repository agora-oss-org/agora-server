// refresh_tokens — powers Agora's token rotation + reuse detection.
// A login starts a "family"; each refresh rotates the token within the family. Replaying a
// spent token (outside the 30s grace) implies theft → the whole family is revoked.
import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { projects, profiles } from "./projects.js";

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
