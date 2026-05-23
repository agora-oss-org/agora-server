-- PostGIS location columns + extension-specific indexes (GIN / GiST / IVFFlat).
-- Kept out of the Drizzle TS schema (customType mis-quotes geography; extension ops).
-- Idempotent: IF NOT EXISTS throughout.
SET search_path TO public, extensions;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "location" geography(Point,4326);
--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "location" geography(Point,4326);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_keywords_gin" ON "entities" USING gin ("keywords");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_metadata_gin" ON "entities" USING gin ("metadata" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_location_gist" ON "entities" USING gist ("location");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profiles_location_gist" ON "profiles" USING gist ("location");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_embeddings_ivfflat" ON "entity_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
