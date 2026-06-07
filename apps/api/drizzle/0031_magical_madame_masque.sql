CREATE TYPE "public"."secure_conversation_type" AS ENUM('dm', 'group', 'channel');--> statement-breakpoint
CREATE TYPE "public"."secure_handshake_kind" AS ENUM('welcome', 'commit', 'proposal');--> statement-breakpoint
CREATE TYPE "public"."secure_member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "secure_conversation_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "secure_member_role" DEFAULT 'member' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"joined_at_epoch" bigint,
	"last_read_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secure_conversation_members_unique" UNIQUE("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "secure_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "secure_conversation_type" NOT NULL,
	"mls_group_id" "bytea" NOT NULL,
	"space_id" uuid,
	"current_epoch" bigint DEFAULT 0 NOT NULL,
	"name" text,
	"created_by_id" uuid,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secure_conversations_channel_space" CHECK (("secure_conversations"."type" = 'channel') = ("secure_conversations"."space_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "secure_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"display_name" text,
	"signature_public_key" "bytea" NOT NULL,
	"credential" "bytea" NOT NULL,
	"ciphersuite" integer NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secure_devices_user_device_unique" UNIQUE("user_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "secure_handshake_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" "secure_handshake_kind" NOT NULL,
	"epoch" bigint NOT NULL,
	"payload" "bytea" NOT NULL,
	"sender_device_id" uuid,
	"target_device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secure_key_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text,
	"blob" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"kdf" text NOT NULL,
	"kdf_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cipher" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secure_key_backups_user_device_unique" UNIQUE("user_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "secure_key_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"key_package_ref" text NOT NULL,
	"key_package" "bytea" NOT NULL,
	"ciphersuite" integer NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secure_key_packages_ref_unique" UNIQUE("device_id","key_package_ref")
);
--> statement-breakpoint
CREATE TABLE "secure_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_user_id" uuid,
	"sender_device_id" uuid,
	"epoch" bigint NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"content_type" text DEFAULT 'application' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secure_conversation_members" ADD CONSTRAINT "secure_conversation_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_conversation_members" ADD CONSTRAINT "secure_conversation_members_conversation_id_secure_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."secure_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_conversation_members" ADD CONSTRAINT "secure_conversation_members_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_conversations" ADD CONSTRAINT "secure_conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_conversations" ADD CONSTRAINT "secure_conversations_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_conversations" ADD CONSTRAINT "secure_conversations_created_by_id_profiles_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_devices" ADD CONSTRAINT "secure_devices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_devices" ADD CONSTRAINT "secure_devices_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_handshake_messages" ADD CONSTRAINT "secure_handshake_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_handshake_messages" ADD CONSTRAINT "secure_handshake_messages_conversation_id_secure_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."secure_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_handshake_messages" ADD CONSTRAINT "secure_handshake_messages_sender_device_id_secure_devices_id_fk" FOREIGN KEY ("sender_device_id") REFERENCES "public"."secure_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_handshake_messages" ADD CONSTRAINT "secure_handshake_messages_target_device_id_secure_devices_id_fk" FOREIGN KEY ("target_device_id") REFERENCES "public"."secure_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_key_backups" ADD CONSTRAINT "secure_key_backups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_key_backups" ADD CONSTRAINT "secure_key_backups_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_key_packages" ADD CONSTRAINT "secure_key_packages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_key_packages" ADD CONSTRAINT "secure_key_packages_device_id_secure_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."secure_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_key_packages" ADD CONSTRAINT "secure_key_packages_consumed_by_user_id_profiles_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_messages" ADD CONSTRAINT "secure_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_messages" ADD CONSTRAINT "secure_messages_conversation_id_secure_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."secure_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_messages" ADD CONSTRAINT "secure_messages_sender_user_id_profiles_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secure_messages" ADD CONSTRAINT "secure_messages_sender_device_id_secure_devices_id_fk" FOREIGN KEY ("sender_device_id") REFERENCES "public"."secure_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secure_conversation_members_user_idx" ON "secure_conversation_members" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "secure_conversations_mls_group_unique" ON "secure_conversations" USING btree ("project_id","mls_group_id");--> statement-breakpoint
CREATE INDEX "secure_conversations_recent_idx" ON "secure_conversations" USING btree ("project_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "secure_conversations_space_idx" ON "secure_conversations" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "secure_devices_user_idx" ON "secure_devices" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "secure_handshake_broadcast_idx" ON "secure_handshake_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "secure_handshake_targeted_idx" ON "secure_handshake_messages" USING btree ("target_device_id","seq");--> statement-breakpoint
CREATE INDEX "secure_key_packages_claimable_idx" ON "secure_key_packages" USING btree ("device_id") WHERE consumed_at is null;--> statement-breakpoint
CREATE INDEX "secure_messages_recent_idx" ON "secure_messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "secure_messages_epoch_idx" ON "secure_messages" USING btree ("conversation_id","epoch");