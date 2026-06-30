-- 0054_conversations_keyset_idx.sql
-- Keyset pagination index for the chat inbox. Matches GET /chat/conversations:
--   ORDER BY COALESCE(last_message_at, created_at) DESC, keyset on the same boundary.
-- created_at is NOT NULL, so the COALESCE result is never NULL (NULLS ordering is moot).
-- Idempotent.
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_keyset_idx"
  ON "conversations" ("project_id", (COALESCE("last_message_at", "created_at")) DESC, "created_at" DESC);
