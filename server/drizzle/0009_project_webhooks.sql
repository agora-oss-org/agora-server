ALTER TABLE "projects" ADD COLUMN "webhook_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "webhook_events" text[] DEFAULT '{}' NOT NULL;