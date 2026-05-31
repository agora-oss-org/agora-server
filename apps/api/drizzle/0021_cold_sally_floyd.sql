ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "moderation_webhook_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "moderation_webhook_secret" text;
