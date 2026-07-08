// Per-user push opt-out set (migration 0060). PK (project_id, user_id).
import { pgTable, uuid, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects, profiles } from "./projects.js";

export const pushNotificationPreferences = pgTable("push_notification_preferences", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  disabledTypes: text("disabled_types").array().notNull().default(sql`'{}'`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.projectId, t.userId] })]);
