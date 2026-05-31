CREATE TYPE "public"."moderation_verdict" AS ENUM('allow', 'block', 'review');--> statement-breakpoint
CREATE TABLE "moderation_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"target_type" "reaction_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"space_id" uuid,
	"verdict" "moderation_verdict" NOT NULL,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"auto_actioned" boolean DEFAULT false NOT NULL,
	"human_resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moderation_analyses" ADD CONSTRAINT "moderation_analyses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_analyses" ADD CONSTRAINT "moderation_analyses_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_analyses_queue_idx" ON "moderation_analyses" USING btree ("project_id","space_id","human_resolved_at");--> statement-breakpoint
CREATE INDEX "moderation_analyses_target_idx" ON "moderation_analyses" USING btree ("target_type","target_id");