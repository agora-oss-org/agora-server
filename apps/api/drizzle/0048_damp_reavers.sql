CREATE TABLE "secure_restore_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"from_device_id" uuid NOT NULL,
	"target_device_id" uuid NOT NULL,
	"blob" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secure_restore_blobs" ADD CONSTRAINT "secure_restore_blobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_restore_blobs" ADD CONSTRAINT "secure_restore_blobs_conversation_id_secure_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."secure_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_restore_blobs" ADD CONSTRAINT "secure_restore_blobs_from_device_id_secure_devices_id_fk" FOREIGN KEY ("from_device_id") REFERENCES "public"."secure_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_restore_blobs" ADD CONSTRAINT "secure_restore_blobs_target_device_id_secure_devices_id_fk" FOREIGN KEY ("target_device_id") REFERENCES "public"."secure_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secure_restore_blobs_target_idx" ON "secure_restore_blobs" USING btree ("target_device_id","created_at");--> statement-breakpoint
CREATE INDEX "secure_restore_blobs_pair_idx" ON "secure_restore_blobs" USING btree ("from_device_id","target_device_id");--> statement-breakpoint
CREATE INDEX "secure_restore_blobs_expiry_idx" ON "secure_restore_blobs" USING btree ("expires_at");--> statement-breakpoint
-- RLS deny-all backstop for secure_restore_blobs (0017's enablement was a one-time DO block; new tables
-- ship their own). No policies -> deny-all for non-owner roles; the server connects as the RLS-bypassing
-- owner, so this is defense-in-depth. These are a server-only relay (no SELECT grant), like the other
-- secure_* tables. Idempotent: enabling RLS twice is a no-op.
ALTER TABLE "secure_restore_blobs" ENABLE ROW LEVEL SECURITY;