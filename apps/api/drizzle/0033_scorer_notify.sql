-- services/scorer: wake the worker instantly via LISTEN/NOTIFY. Durability stays in pgmq (this only
-- removes poll latency); the worker LISTENs on a DIRECT/session connection because NOTIFY is NOT
-- delivered over the Supabase transaction pooler (:6543, PgBouncer). Re-defines enqueue_scorer_job()
-- to also pg_notify after the pgmq.send — NOTIFY is delivered at COMMIT, so it stays aligned with the
-- atomic enqueue (no notify for an aborted insert). Triggers are unchanged. Idempotent (create or replace).
create or replace function enqueue_scorer_job() returns trigger language plpgsql as $$
begin
  perform pgmq.send('scorer_jobs', jsonb_build_object(
    'targetType', tg_argv[0],
    'targetId',   new.id,
    'projectId',  new.project_id
  ));
  perform pg_notify('scorer_jobs', '');  -- wake any LISTENing worker (best-effort; pgmq poll is the backstop)
  return new;
end $$;
