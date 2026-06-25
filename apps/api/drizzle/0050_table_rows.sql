-- Custom-tables `/db` surface: a generic per-project JSONB row store. Idempotent.
CREATE TABLE IF NOT EXISTS "table_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "table_name" text NOT NULL,
  "user_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "table_rows_lookup_idx" ON "table_rows" ("project_id", "table_name", "user_id");
--> statement-breakpoint
-- New table ships its own RLS deny-all (0017's enablement was one-time). No policies -> deny-all for
-- non-owner roles; the server connects as the RLS-bypassing owner, so this is defense-in-depth.
ALTER TABLE "table_rows" ENABLE ROW LEVEL SECURITY;
