-- services/scorer Layer-2: enqueue FRICTION social-edge jobs from the reports table. This is the first
-- *dedicated* friction source — until now Weather derived friction only from negative-sentiment
-- INTERACTED edges (angry/downvote reactions, migration 0036), an explicit interim. A user report now
-- projects a directed (reporter)-[:FRICTION {kind:'report'}]->(subject) edge; Weather folds it into the
-- friction term ADDITIVELY (alongside the negative-INTERACTED signal, which is unchanged). Feeds the SAME
-- pgmq queue ('scorer_jobs') with a `kind` discriminator ('friction'); the worker's dispatch_job routes it
-- to a graph-only path (no scoring — a report carries no text to classify, its weight is a constant).
-- Atomic with the write; idempotent per repo convention (create or replace; drop trigger if exists before
-- create). pgmq is at-least-once, so the worker's Neo4j MERGE is idempotent (keyed on the report id).
--
-- APPEND + DECAY ONLY — INSERT trigger only, NO update/delete trigger. A FRICTION edge, once written,
-- simply DECAYS at the friction half-life (~14d, read-time); a later resolution/dismissal of the report
-- is a NO-OP in the graph. This mirrors the INTERACTED append model: friction *fades*, it is not
-- adjudicated in the graph (adjudication lives in the steward tier, not the public warmth math). So there
-- is deliberately no enqueue on report resolve/delete.
--
-- The subject (recipient) is the AUTHOR of the reported content, resolved worker-side (reports.target_id →
-- entities/comments author). Reports on a chat message (target_type='message') have no graph recipient and
-- the worker skips them (secure chat is end-to-end-encrypted, out of the relationship graph's scope), as
-- do anonymous reports (reporter_id is null). NOTE: enqueues regardless of whether NEO4J_* is set; with
-- Neo4j off the worker consumes and no-ops the job.

create or replace function enqueue_friction_job() returns trigger language plpgsql as $$
begin
  perform pgmq.send('scorer_jobs', jsonb_build_object(
    'kind', 'friction', 'op', 'add',
    'reportId', new.id, 'projectId', new.project_id));
  return new;
end $$;
--> statement-breakpoint
drop trigger if exists trg_scorer_enqueue_ins_reports on reports;
--> statement-breakpoint
create trigger trg_scorer_enqueue_ins_reports
  after insert on reports
  for each row
  execute function enqueue_friction_job();
