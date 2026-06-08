-- services/scorer: pgmq enqueue ("Trigger A"). Replaces the HMAC-webhook moderation notifier with a
-- Postgres trigger that pgmq.send()s a scoring job ATOMICALLY with the content write — the job exists
-- only if the row committed (no lossy hop). Idempotent per repo convention (create extension if not
-- exists; create or replace; drop trigger if exists before create). pgmq is AT-LEAST-ONCE, so the
-- worker's downstream writes (moderation_analyses upsert, Neo4j MERGE) are idempotent.
--
-- Fires on entities and comments — on INSERT and on content-changing
-- UPDATEs. (chat_messages are NOT scored: Agora uses end-to-end-encrypted secure chat, so the server
-- never sees message plaintext — RoBERTa/Haiku scoring is impossible and meaningless there.)
-- The UPDATE trigger is GATED on the text column(s) actually changing, so the moderation
-- write-back itself (which only updates moderation_status) and trigger-maintained count/reaction
-- bumps do NOT re-enqueue (this is what prevents a write-back → re-score loop). INSERT and UPDATE are
-- separate triggers because a WHEN clause referencing OLD is invalid on an INSERT trigger.
--
-- Payload is id-only {targetType, targetId, projectId}; the worker fetches text / space / author by id.
-- This superseded the moderation half of apps/api/src/lib/webhooks.ts (MODERATION_EVENTS +
-- projects.moderation_webhook_url/secret), which has since been removed (migration 0035 drops the
-- columns); webhooks.ts now serves only the external project webhook + sign-up validation.

create extension if not exists pgmq;
--> statement-breakpoint
-- Create the queue idempotently (pgmq.create raises if it already exists).
do $$ begin
  perform pgmq.create('scorer_jobs');
exception when others then
  null; -- queue already exists
end $$;
--> statement-breakpoint
create or replace function enqueue_scorer_job() returns trigger language plpgsql as $$
begin
  perform pgmq.send('scorer_jobs', jsonb_build_object(
    'targetType', tg_argv[0],
    'targetId',   new.id,
    'projectId',  new.project_id
  ));
  return new;
end $$;
--> statement-breakpoint
-- entities: insert always; update only when title/content changed.
drop trigger if exists trg_scorer_enqueue_ins_entities on entities;
--> statement-breakpoint
create trigger trg_scorer_enqueue_ins_entities
  after insert on entities
  for each row execute function enqueue_scorer_job('entity');
--> statement-breakpoint
drop trigger if exists trg_scorer_enqueue_upd_entities on entities;
--> statement-breakpoint
create trigger trg_scorer_enqueue_upd_entities
  after update on entities
  for each row
  when (old.title is distinct from new.title or old.content is distinct from new.content)
  execute function enqueue_scorer_job('entity');
--> statement-breakpoint
-- comments: insert always; update only when content changed.
drop trigger if exists trg_scorer_enqueue_ins_comments on comments;
--> statement-breakpoint
create trigger trg_scorer_enqueue_ins_comments
  after insert on comments
  for each row execute function enqueue_scorer_job('comment');
--> statement-breakpoint
drop trigger if exists trg_scorer_enqueue_upd_comments on comments;
--> statement-breakpoint
create trigger trg_scorer_enqueue_upd_comments
  after update on comments
  for each row
  when (old.content is distinct from new.content)
  execute function enqueue_scorer_job('comment');
