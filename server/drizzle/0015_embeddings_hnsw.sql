-- Replace the IVFFlat vector indexes with HNSW.
--
-- IVFFlat is an *approximate* index that partitions vectors into `lists` and probes only
-- `ivfflat.probes` (default 1) of them per query. With a small/young dataset almost every query
-- probes an empty list and returns ZERO rows — so semantic search (match_content → ORDER BY
-- embedding <=> query LIMIT n) silently came back empty until the table had thousands of rows
-- spread across the 100 lists. HNSW has no training step and no empty-list failure mode: it gives
-- strong recall at any row count, so search works from the very first embedding. (pgvector >= 0.5;
-- this DB is 0.8.) Cosine ops match how match_content computes `1 - (embedding <=> query)`.
--
-- Idempotent: drop the old index if present, create the new one if absent.

DROP INDEX IF EXISTS "content_embeddings_ivfflat";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_embeddings_hnsw" ON "content_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint

DROP INDEX IF EXISTS "entity_embeddings_ivfflat";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_embeddings_hnsw" ON "entity_embeddings" USING hnsw ("embedding" vector_cosine_ops);
