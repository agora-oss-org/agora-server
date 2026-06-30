-- apps/api/drizzle/0055_push_devices.sql
-- Per-user push registrations. Platform CHECK + the two partial UNIQUE indexes (native token / web
-- endpoint). Idempotent + RLS deny-all (new tables aren't covered by the 0017 guard).
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "token" text,
  "subscription" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "push_devices_platform_chk" CHECK ("platform" IN ('ios','android','web')),
  CONSTRAINT "push_devices_shape_chk" CHECK (
       ("platform" IN ('ios','android') AND "token" IS NOT NULL AND "subscription" IS NULL)
    OR ("platform" = 'web' AND "subscription" IS NOT NULL AND "token" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_devices_native_unique"
  ON "push_devices" ("project_id","user_id","platform","token") WHERE "platform" IN ('ios','android');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_devices_web_unique"
  ON "push_devices" ("project_id","user_id",("subscription"->>'endpoint')) WHERE "platform" = 'web';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_devices_user_idx" ON "push_devices" ("project_id","user_id");
--> statement-breakpoint
ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "push_devices"; CREATE POLICY "deny_all" ON "push_devices" FOR ALL USING (false) WITH CHECK (false);
