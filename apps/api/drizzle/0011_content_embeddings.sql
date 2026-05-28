CREATE TABLE "content_embeddings" (
	"project_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"embedding" vector(1024),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_embeddings_source_type_source_id_pk" PRIMARY KEY("source_type","source_id")
);
--> statement-breakpoint
ALTER TABLE "content_embeddings" ADD CONSTRAINT "content_embeddings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_embeddings_project_idx" ON "content_embeddings" USING btree ("project_id");--> statement-breakpoint
-- ivfflat index for cosine similarity (extension op; not expressible in Drizzle schema).
CREATE INDEX IF NOT EXISTS "content_embeddings_ivfflat" ON "content_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
--> statement-breakpoint
-- Backfill existing entity embeddings into the generic table (idempotent).
INSERT INTO content_embeddings (project_id, source_type, source_id, embedding, updated_at)
  SELECT project_id, 'entity', entity_id, embedding, updated_at FROM entity_embeddings
  ON CONFLICT (source_type, source_id) DO NOTHING;
--> statement-breakpoint
-- Generic semantic search across source types, honoring sourceTypes + (entity/comment) space filter.
-- Liveness is checked per type so stale embeddings of deleted/removed rows are never returned.
CREATE OR REPLACE FUNCTION match_content(
  p_project uuid, p_embedding vector(1024), p_limit int default 20,
  p_source_types text[] default null, p_space uuid default null
) RETURNS TABLE (source_type text, source_id uuid, similarity double precision)
LANGUAGE sql STABLE AS $$
  SELECT ce.source_type, ce.source_id, 1 - (ce.embedding <=> p_embedding) AS similarity
  FROM content_embeddings ce
  WHERE ce.project_id = p_project
    AND (p_source_types IS NULL OR ce.source_type = ANY(p_source_types))
    AND CASE ce.source_type
      WHEN 'entity' THEN EXISTS (
        SELECT 1 FROM entities e WHERE e.id = ce.source_id AND e.deleted_at IS NULL
          AND (p_space IS NULL OR e.space_id = p_space))
      WHEN 'comment' THEN EXISTS (
        SELECT 1 FROM comments c JOIN entities e ON e.id = c.entity_id
          WHERE c.id = ce.source_id AND c.deleted_at IS NULL
          AND (p_space IS NULL OR e.space_id = p_space))
      WHEN 'message' THEN p_space IS NULL AND EXISTS (
        SELECT 1 FROM chat_messages m WHERE m.id = ce.source_id AND m.user_deleted_at IS NULL)
      ELSE true
    END
  ORDER BY ce.embedding <=> p_embedding
  LIMIT p_limit;
$$;
