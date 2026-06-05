CREATE TYPE "public"."steward_case_event_kind" AS ENUM('opened', 'note', 'state_change', 'assignment', 'asymmetry', 'outcome', 'escalation');--> statement-breakpoint
CREATE TYPE "public"."steward_case_outcome" AS ENUM('repaired', 'separated', 'protective_action', 'escalated', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."steward_case_state" AS ENUM('open', 'in_mediation', 'closed');--> statement-breakpoint
CREATE TABLE "project_stewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"granted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_stewards_unique" UNIQUE("project_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "steward_case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" "steward_case_event_kind" NOT NULL,
	"body" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steward_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"report_id" uuid,
	"complainant_id" uuid,
	"respondent_id" uuid,
	"subject_type" "reaction_target",
	"subject_id" uuid,
	"space_id" uuid,
	"summary" text DEFAULT '' NOT NULL,
	"state" "steward_case_state" DEFAULT 'open' NOT NULL,
	"outcome" "steward_case_outcome",
	"asymmetry" boolean DEFAULT false NOT NULL,
	"resolution_note" text,
	"opened_by_id" uuid,
	"assigned_to_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_stewards" ADD CONSTRAINT "project_stewards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stewards" ADD CONSTRAINT "project_stewards_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stewards" ADD CONSTRAINT "project_stewards_granted_by_id_profiles_id_fk" FOREIGN KEY ("granted_by_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_case_events" ADD CONSTRAINT "steward_case_events_case_id_steward_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."steward_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_case_events" ADD CONSTRAINT "steward_case_events_actor_id_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_cases" ADD CONSTRAINT "steward_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_cases" ADD CONSTRAINT "steward_cases_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_cases" ADD CONSTRAINT "steward_cases_complainant_id_profiles_id_fk" FOREIGN KEY ("complainant_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_cases" ADD CONSTRAINT "steward_cases_respondent_id_profiles_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_cases" ADD CONSTRAINT "steward_cases_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_cases" ADD CONSTRAINT "steward_cases_opened_by_id_profiles_id_fk" FOREIGN KEY ("opened_by_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_cases" ADD CONSTRAINT "steward_cases_assigned_to_id_profiles_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "steward_case_events_timeline_idx" ON "steward_case_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "steward_cases_queue_idx" ON "steward_cases" USING btree ("project_id","state","created_at");