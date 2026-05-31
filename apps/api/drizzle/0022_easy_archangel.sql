ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "moderator_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
