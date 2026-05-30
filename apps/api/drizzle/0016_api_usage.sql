-- Per-project, per-month request metering (admin dashboard "App metering"). Hand-written + idempotent
-- (db:generate is currently blocked by a snapshot collision). Safe to re-run.
CREATE TABLE IF NOT EXISTS "api_usage" (
	"project_id" uuid NOT NULL,
	"month" date NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	"duration_ms_total" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_usage_project_id_month_pk" PRIMARY KEY("project_id","month")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
