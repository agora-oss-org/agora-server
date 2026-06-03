-- Hourly community-activity rollup for the operator-only "Community" dashboard (lib/community-stats.ts).
-- Idempotent (CREATE TABLE IF NOT EXISTS + guarded FK) so it's safe to re-run. RLS enabled with NO
-- policies → deny-all to anon/authenticated (server-only), matching the 0004/0017 backstop; the
-- enablement loop in 0017 only covers tables that existed then, so a table added later must opt in here.
CREATE TABLE IF NOT EXISTS "community_stats_hourly" (
	"project_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"new_users" integer DEFAULT 0 NOT NULL,
	"new_posts" integer DEFAULT 0 NOT NULL,
	"new_comments" integer DEFAULT 0 NOT NULL,
	"new_reactions" integer DEFAULT 0 NOT NULL,
	"active_posters" integer DEFAULT 0 NOT NULL,
	"active_commenters" integer DEFAULT 0 NOT NULL,
	"active_reactors" integer DEFAULT 0 NOT NULL,
	"reports_opened" integer DEFAULT 0 NOT NULL,
	"reports_resolved" integer DEFAULT 0 NOT NULL,
	"total_users" integer DEFAULT 0 NOT NULL,
	"total_posts" integer DEFAULT 0 NOT NULL,
	"total_comments" integer DEFAULT 0 NOT NULL,
	"total_reactions" integer DEFAULT 0 NOT NULL,
	"top_posters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"top_commenters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"top_reactors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"top_posts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_stats_hourly_project_id_hour_pk" PRIMARY KEY("project_id","hour")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "community_stats_hourly" ADD CONSTRAINT "community_stats_hourly_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "community_stats_hourly" ENABLE ROW LEVEL SECURITY;
