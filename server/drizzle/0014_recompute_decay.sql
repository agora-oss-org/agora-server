-- Stored-mode true-decay recompute: snapshots the evaluated half-life score into entities.score so
-- `ORDER BY score DESC` stays index-served between cron ticks. Mirrors the query-time `decay`
-- expression in server/src/lib/ranking.ts. Net vote uses the per-project reaction weights (jsonb).
-- Idempotent (create or replace). hot/top projects keep using recompute_scores() (hot_score).
CREATE OR REPLACE FUNCTION recompute_decay_scores(p_project uuid, p_half_life_hours double precision, p_weights jsonb)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH calc AS (
    SELECT e.id,
      ( coalesce((p_weights->>'upvote')::float8, 0) * coalesce((e.reaction_counts->>'upvote')::int, 0)
      + coalesce((p_weights->>'like')::float8, 0)   * coalesce((e.reaction_counts->>'like')::int, 0)
      + coalesce((p_weights->>'love')::float8, 0)   * coalesce((e.reaction_counts->>'love')::int, 0)
      + coalesce((p_weights->>'wow')::float8, 0)    * coalesce((e.reaction_counts->>'wow')::int, 0)
      + coalesce((p_weights->>'funny')::float8, 0)  * coalesce((e.reaction_counts->>'funny')::int, 0)
      + coalesce((p_weights->>'sad')::float8, 0)    * coalesce((e.reaction_counts->>'sad')::int, 0)
      + coalesce((p_weights->>'angry')::float8, 0)  * coalesce((e.reaction_counts->>'angry')::int, 0)
      - coalesce((p_weights->>'downvote')::float8, 0) * coalesce((e.reaction_counts->>'downvote')::int, 0)
      ) AS net,
      greatest(extract(epoch FROM (now() - e.created_at)) / 3600.0, 0) AS age_h
    FROM entities e
    WHERE e.deleted_at IS NULL AND (p_project IS NULL OR e.project_id = p_project)
  )
  UPDATE entities e SET
    score = sign(calc.net) * log(greatest(abs(calc.net), 1)) - 0.6931471805599453 * calc.age_h / greatest(p_half_life_hours, 0.1),
    score_updated_at = now()
  FROM calc WHERE e.id = calc.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
