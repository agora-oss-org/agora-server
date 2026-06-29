-- apps/api/drizzle/0053_events.sql
-- Events domain: enums, tables, indexes, RLS deny-all, PostGIS location, files.event_id.
-- Hand-authored + idempotent (db:generate is not used in this repo).
SET search_path TO public, extensions;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "event_type" AS ENUM ('online','physical','hybrid'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "event_visibility" AS ENUM ('public','members','invite'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "event_status" AS ENUM ('active','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "rsvp_status" AS ENUM ('going','maybe','not_going'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "short_id" text NOT NULL,
  "user_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "description" text,
  "start_time" timestamptz NOT NULL,
  "end_time" timestamptz,
  "timezone" text,
  "type" "event_type" NOT NULL,
  "url" text,
  "venue_name" text,
  "address" text,
  "space_id" uuid,
  "visibility" "event_visibility" NOT NULL DEFAULT 'public',
  "status" "event_status" NOT NULL DEFAULT 'active',
  "allow_maybe" boolean NOT NULL DEFAULT true,
  "guest_list_visible" boolean NOT NULL DEFAULT true,
  "capacity" integer,
  "cover_image_id" uuid,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "moderation_status" "moderation_status",
  "moderated_at" timestamptz,
  "moderated_by_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL,
  "moderated_by_type" "moderated_by_type",
  "moderation_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_project_short" ON "events" ("project_id","short_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_feed_idx" ON "events" ("project_id","start_time");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_space_idx" ON "events" ("project_id","space_id");
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "location" geography(Point,4326);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_location_gist" ON "events" USING gist ("location");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_rsvps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "status" "rsvp_status" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_rsvps_unique" ON "event_rsvps" ("event_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_rsvps_event_idx" ON "event_rsvps" ("event_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "invited_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_invites_unique" ON "event_invites" ("event_id","user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_hosts" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "event_hosts_pk" PRIMARY KEY ("event_id","user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_hosts_user_idx" ON "event_hosts" ("project_id","user_id");
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "event_id" uuid REFERENCES "events"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_event_idx" ON "files" ("event_id");
--> statement-breakpoint
-- RLS deny-all backstop (new tables aren't covered by the one-time 0017 guard). Server bypasses RLS
-- as the owner role; this is defense-in-depth (SECURITY.md).
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_rsvps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_invites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_hosts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "events"; CREATE POLICY "deny_all" ON "events" FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "event_rsvps"; CREATE POLICY "deny_all" ON "event_rsvps" FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "event_invites"; CREATE POLICY "deny_all" ON "event_invites" FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "event_hosts"; CREATE POLICY "deny_all" ON "event_hosts" FOR ALL USING (false) WITH CHECK (false);
