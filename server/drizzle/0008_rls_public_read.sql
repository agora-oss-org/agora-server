-- RLS public-read policies (Option A). Lets clients read PUBLIC content directly via the
-- publishable/anon key (a future performance path); the Agora server uses the owner role and
-- bypasses RLS regardless. Writes have NO policy → denied to anon/authenticated (server-only).
-- Private tables (profiles, messages, notifications, collections, files, reports, refresh_tokens,
-- embeddings, …) get NO policy → stay fully locked. profiles is intentionally excluded: RLS is
-- row- not column-level, so exposing it would leak email/secure_metadata (the server strips those).
-- Idempotent: drop policy if exists before create.

-- spaces: only "anyone"-readable, non-deleted spaces are public.
GRANT SELECT ON "spaces" TO anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "spaces_public_read" ON "spaces";
--> statement-breakpoint
CREATE POLICY "spaces_public_read" ON "spaces" FOR SELECT TO anon, authenticated
  USING (deleted_at IS NULL AND reading_permission = 'anyone');
--> statement-breakpoint

-- entities: visible (not deleted/removed/draft) AND not inside a private space.
GRANT SELECT ON "entities" TO anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "entities_public_read" ON "entities";
--> statement-breakpoint
CREATE POLICY "entities_public_read" ON "entities" FOR SELECT TO anon, authenticated
  USING (
    deleted_at IS NULL
    AND moderation_status IS DISTINCT FROM 'removed'
    AND is_draft IS NOT TRUE
    AND (space_id IS NULL OR space_id IN (
      SELECT id FROM spaces WHERE reading_permission = 'anyone' AND deleted_at IS NULL))
  );
--> statement-breakpoint

-- comments: visible only when their parent entity is publicly visible.
GRANT SELECT ON "comments" TO anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "comments_public_read" ON "comments";
--> statement-breakpoint
CREATE POLICY "comments_public_read" ON "comments" FOR SELECT TO anon, authenticated
  USING (
    deleted_at IS NULL
    AND moderation_status IS DISTINCT FROM 'removed'
    AND entity_id IN (
      SELECT id FROM entities
      WHERE deleted_at IS NULL AND moderation_status IS DISTINCT FROM 'removed' AND is_draft IS NOT TRUE
        AND (space_id IS NULL OR space_id IN (
          SELECT id FROM spaces WHERE reading_permission = 'anyone' AND deleted_at IS NULL)))
  );
--> statement-breakpoint

-- space_rules: public for public spaces.
GRANT SELECT ON "space_rules" TO anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "space_rules_public_read" ON "space_rules";
--> statement-breakpoint
CREATE POLICY "space_rules_public_read" ON "space_rules" FOR SELECT TO anon, authenticated
  USING (space_id IN (
    SELECT id FROM spaces WHERE reading_permission = 'anyone' AND deleted_at IS NULL));
--> statement-breakpoint

-- follows + reactions: low-sensitivity public social signal.
GRANT SELECT ON "follows" TO anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "follows_public_read" ON "follows";
--> statement-breakpoint
CREATE POLICY "follows_public_read" ON "follows" FOR SELECT TO anon, authenticated USING (true);
--> statement-breakpoint

GRANT SELECT ON "reactions" TO anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "reactions_public_read" ON "reactions";
--> statement-breakpoint
CREATE POLICY "reactions_public_read" ON "reactions" FOR SELECT TO anon, authenticated USING (true);
