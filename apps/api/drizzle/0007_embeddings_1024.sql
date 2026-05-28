-- Resize embeddings 1536 -> 1024 (Voyage voyage-3.5). Drop the ivfflat index first (it depends
-- on the column dimension), alter, recreate the index, and recreate match_entities for vector(1024).
SET search_path TO public, extensions;
--> statement-breakpoint
DROP INDEX IF EXISTS "entity_embeddings_ivfflat";
--> statement-breakpoint
ALTER TABLE "entity_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(1024);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_embeddings_ivfflat" ON "entity_embeddings" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
--> statement-breakpoint
create or replace function match_entities(
  p_project uuid, p_embedding vector(1024), p_limit int default 20, p_space uuid default null
) returns table (entity_id uuid, similarity double precision)
language sql stable as $$
  select e.entity_id, 1 - (e.embedding <=> p_embedding) as similarity
  from entity_embeddings e
  join entities ent on ent.id = e.entity_id
  where e.project_id = p_project
    and ent.deleted_at is null
    and (p_space is null or ent.space_id = p_space)
  order by e.embedding <=> p_embedding
  limit p_limit;
$$;