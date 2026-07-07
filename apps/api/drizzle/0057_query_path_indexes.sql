-- 0057_query_path_indexes.sql
-- Indexes for hot query paths surfaced by the API-query index audit. All plain btree,
-- all mirrored in the Drizzle schema (packages/core/src/db/schema/*.ts). Idempotent.
--
--   profiles_auth_user_idx        — profileByAuthUser() runs on every sign-in/sign-up/OAuth
--                                   callback/external-user verify (auth.ts); previously seq-scanned.
--   profiles_reputation_idx       — GET /users/suggestions orders by reputation within a tenant.
--   collection_entities_entity_idx— the per-entity "is this saved?" check looks up by entity_id
--                                   alone; the PK leads with collection_id and can't serve it.
--   refresh_tokens_expires_idx    — the purge-tokens cron deletes WHERE expires_at < now();
--                                   without this it full-scans an ever-growing table.
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profiles_auth_user_idx"
  ON "profiles" ("project_id", "auth_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profiles_reputation_idx"
  ON "profiles" ("project_id", "reputation" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collection_entities_entity_idx"
  ON "collection_entities" ("entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_idx"
  ON "refresh_tokens" ("expires_at");
