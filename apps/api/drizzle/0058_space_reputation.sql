-- apps/api/drizzle/0058_space_reputation.sql
-- Per-(user, space) reputation: the space-partitioned twin of profiles.reputation. Trigger-maintained
-- (see 0059). Composite PK is the upsert conflict target. Idempotent + RLS deny-all (new tables aren't
-- covered by the 0017 guard).
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "space_reputation" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "space_id"   uuid NOT NULL REFERENCES "spaces"("id")   ON DELETE CASCADE,
  "user_id"    uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "reputation" integer NOT NULL DEFAULT 0,
  CONSTRAINT "space_reputation_pk" PRIMARY KEY ("project_id","space_id","user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_reputation_user_idx" ON "space_reputation" ("project_id","user_id");
--> statement-breakpoint
ALTER TABLE "space_reputation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "space_reputation"; CREATE POLICY "deny_all" ON "space_reputation" FOR ALL USING (false) WITH CHECK (false);
