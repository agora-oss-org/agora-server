CREATE TABLE "social_constellation" (
	"project_id" uuid NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"blobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_constellation_project_id_computed_at_pk" PRIMARY KEY("project_id","computed_at")
);
--> statement-breakpoint
ALTER TABLE "social_constellation" ADD CONSTRAINT "social_constellation_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;