CREATE TYPE "public"."auth_email_token_kind" AS ENUM('confirm', 'reset');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('supabase', 'native');--> statement-breakpoint
CREATE TABLE "auth_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_credentials_project_email" UNIQUE("project_id","email")
);
--> statement-breakpoint
CREATE TABLE "auth_email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL,
	"kind" "auth_email_token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auth_provider" "auth_provider" DEFAULT 'supabase' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_credentials" ADD CONSTRAINT "auth_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_credential_id_auth_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."auth_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_email_tokens_hash_idx" ON "auth_email_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_email_tokens_credential_idx" ON "auth_email_tokens" USING btree ("credential_id");