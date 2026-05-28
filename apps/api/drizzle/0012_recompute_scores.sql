-- Batch score recompute. hot_score() is time-anchored to created_at (Reddit-style), so this is a
-- consistency/backfill pass — it re-syncs entities.score to the current reaction_counts for a
-- project (or all projects). Useful after bulk imports or any drift; safe to run on a cron.
-- Idempotent (create or replace); returns the number of rows updated.
CREATE OR REPLACE FUNCTION recompute_scores(p_project uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  UPDATE entities SET score = hot_score(reaction_counts, created_at), score_updated_at = now()
  WHERE deleted_at IS NULL AND (p_project IS NULL OR project_id = p_project);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
