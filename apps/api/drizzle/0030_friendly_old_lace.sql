ALTER TYPE "public"."steward_case_event_kind" ADD VALUE 'mediation_opened';--> statement-breakpoint
ALTER TYPE "public"."steward_case_event_kind" ADD VALUE 'mediation_closed';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "steward_case_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_steward_case_id_steward_cases_id_fk" FOREIGN KEY ("steward_case_id") REFERENCES "public"."steward_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_steward_case_idx" ON "conversations" USING btree ("steward_case_id");