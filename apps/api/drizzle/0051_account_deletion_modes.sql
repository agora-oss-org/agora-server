-- Account-deletion: provider-agnostic confirmation codes + soft/ban support. Idempotent.
ALTER TABLE "auth_credentials" ADD COLUMN IF NOT EXISTS "disabled_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "account_deletion_mode" text DEFAULT 'hard' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_deletion_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_deletion_codes_profile_idx" ON "account_deletion_codes" ("profile_id");
--> statement-breakpoint
-- New table ships its own RLS deny-all (server connects as the RLS-bypassing owner; defense-in-depth).
ALTER TABLE "account_deletion_codes" ENABLE ROW LEVEL SECURITY;
