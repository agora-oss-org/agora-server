-- apps/api/drizzle/0059_conversation_member_muted_forever.sql
-- Per-conversation "mute forever" (SDK v7.8.2, PR #44). Sentinel stored as a dedicated boolean so the
-- client never string-matches a magic far-future muted_until. Idempotent.
SET search_path TO public, extensions;
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN IF NOT EXISTS "muted_forever" boolean NOT NULL DEFAULT false;
