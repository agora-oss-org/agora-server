CREATE TABLE "read_receipts" (
	"project_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_receipts_project_id_entity_id_user_id_pk" PRIMARY KEY("project_id","entity_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "read_receipts_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "read_receipts" ADD CONSTRAINT "read_receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipts" ADD CONSTRAINT "read_receipts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipts" ADD CONSTRAINT "read_receipts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_receipts" ADD CONSTRAINT "read_receipts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "read_receipts_space_idx" ON "read_receipts" USING btree ("project_id","space_id");--> statement-breakpoint
-- RLS deny-all backstop for read_receipts (0017's enablement was a one-time DO block; new tables ship
-- their own). No policies -> deny-all for non-owner roles; the server connects as the RLS-bypassing
-- owner, so this is defense-in-depth. Idempotent: enabling RLS twice is a no-op.
ALTER TABLE "read_receipts" ENABLE ROW LEVEL SECURITY;