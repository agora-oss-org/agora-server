ALTER TABLE "moderation_analyses" ADD COLUMN IF NOT EXISTS "prompt_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_analyses" ADD COLUMN IF NOT EXISTS "completion_tokens" integer DEFAULT 0 NOT NULL;
