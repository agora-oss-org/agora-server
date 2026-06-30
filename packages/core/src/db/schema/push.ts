// push_devices — per-user OS push registrations (SDK v7.6.2). The platform CHECK + the two partial
// UNIQUE indexes (native by token, web by subscription->>'endpoint') are added in the custom migration
// (Drizzle can't express a partial unique on a jsonb expression).
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { projects, profiles } from "./projects.js";

export const pushDevices = pgTable("push_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(), // 'ios' | 'android' | 'web' (CHECK in migration)
  token: text("token"),                  // native APNs/FCM token
  subscription: jsonb("subscription"),   // web: { endpoint, keys: { p256dh, auth } }
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("push_devices_user_idx").on(t.projectId, t.userId),
]);
