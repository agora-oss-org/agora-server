-- services/scorer graph v2: enqueue user→user interaction-graph jobs. Adds reaction + follow enqueue
-- triggers feeding the SAME pgmq queue ('scorer_jobs') as the content scorer (migration 0027), each job
-- carrying a `kind` discriminator so the worker routes it to the graph-only path (no scoring). Atomic
-- with the write (the job exists iff the row committed); idempotent per repo convention (create or
-- replace; drop trigger if exists before create). pgmq is at-least-once, so the worker's Neo4j
-- MERGE/DELETE are idempotent.
--
-- Reactions feed the user→user INTERACTED edge with sentiment derived from the reaction TYPE (no text
-- to classify). A toggle to a DIFFERENT reaction type re-scores the edge, so the UPDATE trigger is GATED
-- on reaction_type actually changing — a plain updated_at bump does NOT re-enqueue. Follows feed the
-- structural FOLLOWS edge (add → MERGE, remove → DELETE).
--
-- NOTE: these triggers enqueue regardless of whether NEO4J_* is configured; with Neo4j off the worker
-- consumes and no-ops the job. Reaction volume is real — the documented "off" gate is dropping these
-- triggers. (chat-message reactions DO enqueue, but the worker skips target_type='message': secure chat
-- is end-to-end-encrypted and out of the relationship graph's scope.)

create or replace function enqueue_reaction_job() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform pgmq.send('scorer_jobs', jsonb_build_object(
      'kind', 'reaction', 'op', 'remove',
      'reactionId', old.id, 'projectId', old.project_id));
    return old;
  else
    perform pgmq.send('scorer_jobs', jsonb_build_object(
      'kind', 'reaction', 'op', 'add',
      'reactionId', new.id, 'projectId', new.project_id));
    return new;
  end if;
end $$;
--> statement-breakpoint
create or replace function enqueue_follow_job() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform pgmq.send('scorer_jobs', jsonb_build_object(
      'kind', 'follow', 'op', 'remove',
      'followerId', old.follower_id, 'followedId', old.followed_id, 'projectId', old.project_id));
    return old;
  else
    perform pgmq.send('scorer_jobs', jsonb_build_object(
      'kind', 'follow', 'op', 'add',
      'followerId', new.follower_id, 'followedId', new.followed_id, 'projectId', new.project_id));
    return new;
  end if;
end $$;
--> statement-breakpoint
-- reactions: enqueue on add / remove / retype.
drop trigger if exists trg_scorer_enqueue_ins_reactions on reactions;
--> statement-breakpoint
create trigger trg_scorer_enqueue_ins_reactions
  after insert on reactions
  for each row execute function enqueue_reaction_job();
--> statement-breakpoint
drop trigger if exists trg_scorer_enqueue_upd_reactions on reactions;
--> statement-breakpoint
create trigger trg_scorer_enqueue_upd_reactions
  after update on reactions
  for each row
  when (old.reaction_type is distinct from new.reaction_type)
  execute function enqueue_reaction_job();
--> statement-breakpoint
drop trigger if exists trg_scorer_enqueue_del_reactions on reactions;
--> statement-breakpoint
create trigger trg_scorer_enqueue_del_reactions
  after delete on reactions
  for each row execute function enqueue_reaction_job();
--> statement-breakpoint
-- follows: enqueue on add / remove.
drop trigger if exists trg_scorer_enqueue_ins_follows on follows;
--> statement-breakpoint
create trigger trg_scorer_enqueue_ins_follows
  after insert on follows
  for each row execute function enqueue_follow_job();
--> statement-breakpoint
drop trigger if exists trg_scorer_enqueue_del_follows on follows;
--> statement-breakpoint
create trigger trg_scorer_enqueue_del_follows
  after delete on follows
  for each row execute function enqueue_follow_job();
