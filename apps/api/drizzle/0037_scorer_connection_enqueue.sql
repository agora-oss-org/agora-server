-- services/scorer graph v2.1: enqueue CONNECTED structural-edge jobs from the connections table.
-- Adds a SECOND structural relationship alongside FOLLOWS (migration 0036) — connections are MUTUAL
-- (queried undirected) and STATEFUL (connection_status: pending → connected → declined), distinct from
-- the asymmetric, instant follows. Feeds the SAME pgmq queue ('scorer_jobs') with a `kind` discriminator
-- ('connection'); the worker's dispatch_job routes it to a graph-only path (no scoring). Atomic with the
-- write; idempotent per repo convention (create or replace; drop trigger if exists before create). pgmq is
-- at-least-once, so the worker's Neo4j MERGE/DELETE are idempotent.
--
-- The CONNECTED edge exists ONLY while status='connected'. A `pending` request is NOT a relationship
-- (no edge); the edge is created when the row BECOMES connected and removed when it LEAVES connected.
-- The triggers are WHEN-gated so enqueue_connection_job() only runs on edge-relevant transitions:
--   • INSERT status='connected' (direct connect)            → add
--   • UPDATE pending→connected (request accepted)           → add
--   • UPDATE connected→non-connected (defensive; see below) → remove
--   • DELETE a connected row (disconnect — routes/connections.ts deletes the row, NOT a status flip) → remove
-- Declining a PENDING request (pending→declined) never had an edge, so the UPDATE WHEN clause (which
-- requires one side to be 'connected') correctly skips it. `declined` is "no edge", not a negative signal
-- (the enum has no `blocked`). NOTE: enqueues regardless of whether NEO4J_* is set; the worker no-ops the
-- job when Neo4j is off.

create or replace function enqueue_connection_job() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform pgmq.send('scorer_jobs', jsonb_build_object(
      'kind', 'connection', 'op', 'remove',
      'requesterId', old.requester_id, 'addresseeId', old.addressee_id, 'projectId', old.project_id));
    return old;
  elsif tg_op = 'UPDATE' and new.status is distinct from 'connected' then
    -- left the connected state via UPDATE (defensive — no current code path sets connected→declined)
    perform pgmq.send('scorer_jobs', jsonb_build_object(
      'kind', 'connection', 'op', 'remove',
      'requesterId', new.requester_id, 'addresseeId', new.addressee_id, 'projectId', new.project_id));
    return new;
  else
    -- INSERT connected, or UPDATE → connected (request accepted)
    perform pgmq.send('scorer_jobs', jsonb_build_object(
      'kind', 'connection', 'op', 'add',
      'requesterId', new.requester_id, 'addresseeId', new.addressee_id, 'projectId', new.project_id));
    return new;
  end if;
end $$;
--> statement-breakpoint
-- INSERT: only when the row starts out connected.
drop trigger if exists trg_scorer_enqueue_ins_connections on connections;
--> statement-breakpoint
create trigger trg_scorer_enqueue_ins_connections
  after insert on connections
  for each row
  when (new.status = 'connected')
  execute function enqueue_connection_job();
--> statement-breakpoint
-- UPDATE: only on a status change where one side is connected (accept = add; leave connected = remove).
drop trigger if exists trg_scorer_enqueue_upd_connections on connections;
--> statement-breakpoint
create trigger trg_scorer_enqueue_upd_connections
  after update on connections
  for each row
  when (old.status is distinct from new.status and (new.status = 'connected' or old.status = 'connected'))
  execute function enqueue_connection_job();
--> statement-breakpoint
-- DELETE: only when a connected row is removed (disconnect).
drop trigger if exists trg_scorer_enqueue_del_connections on connections;
--> statement-breakpoint
create trigger trg_scorer_enqueue_del_connections
  after delete on connections
  for each row
  when (old.status = 'connected')
  execute function enqueue_connection_job();
