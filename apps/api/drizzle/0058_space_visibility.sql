-- apps/api/drizzle/0058_space_visibility.sql
-- Space discoverability axis (SDK v7.8.2, PR #43): public|unlisted|private, distinct from
-- reading/posting permission. This cycle persists + emits the field only (no listing filtering yet).
-- Idempotent: guarded enum create + ADD COLUMN IF NOT EXISTS.
SET search_path TO public, extensions;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "space_visibility" AS ENUM ('public', 'unlisted', 'private');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "visibility" "space_visibility" NOT NULL DEFAULT 'public';
