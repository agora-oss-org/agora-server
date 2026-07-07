-- apps/api/drizzle/0060_push_notification_preferences.sql
-- Per-user push opt-OUT set (SDK useNotificationPreferences). One row per (project,user); the push
-- dispatch bridge skips an event whose type is in disabled_types. New table ⇒ ships its own RLS
-- deny-all (the 0017 enablement guard only covers tables that existed then). Idempotent.
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_notification_preferences" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "disabled_types" text[] NOT NULL DEFAULT '{}',
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "push_notification_preferences_pk" PRIMARY KEY ("project_id", "user_id")
);
--> statement-breakpoint
ALTER TABLE "push_notification_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "push_notification_preferences"; CREATE POLICY "deny_all" ON "push_notification_preferences" FOR ALL USING (false) WITH CHECK (false);
