-- apps/api/drizzle/0056_analysis_raw_signals.sql
-- Raw classifier signals on the moderation_analyses audit row: toxicity_score = P(toxic) from the
-- toxicity RoBERTa (0..1); relationship_score = signed sentiment P(positive)−P(negative) (−1..1).
-- Nullable, no default — 0 is meaningful; pre-existing rows stay NULL. Recorded on every verdict
-- (incl. allow) as human-review context and as the validation dataset for the documented-but-not-
-- implemented "disagreement routing" idea (docs/SCORER.md). Idempotent.
SET search_path TO public, extensions;
--> statement-breakpoint
ALTER TABLE "moderation_analyses" ADD COLUMN IF NOT EXISTS "toxicity_score" double precision;
--> statement-breakpoint
ALTER TABLE "moderation_analyses" ADD COLUMN IF NOT EXISTS "relationship_score" double precision;
