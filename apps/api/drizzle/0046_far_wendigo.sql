CREATE TABLE "social_analytics" (
	"project_id" uuid NOT NULL,
	"report" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_analytics_project_id_report_computed_at_pk" PRIMARY KEY("project_id","report","computed_at")
);
--> statement-breakpoint
ALTER TABLE "social_analytics" ADD CONSTRAINT "social_analytics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;