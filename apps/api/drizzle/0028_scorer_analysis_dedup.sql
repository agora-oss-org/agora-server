-- services/scorer idempotency: dedup the moderation_analyses insert under pgmq's at-least-once
-- redelivery. The worker stamps the pgmq message id (source_msg_id) on each analysis it records and
-- inserts ON CONFLICT (source_msg_id) DO NOTHING. So:
--   • a REDELIVERED job (same msg_id, e.g. the worker crashed before pgmq.delete) → no duplicate row;
--   • a genuine RE-SCORE (content edit → a NEW pgmq message → new msg_id) → a new row (correct);
--   • an on-demand /analyze (no pgmq message) → null msg_id, which the partial index leaves unconstrained
--     (Postgres unique indexes allow many NULLs; the partial WHERE makes that explicit + skips them).
-- This preserves the append-log semantics + cumulative /stats + token metering (vs an upsert that would
-- collapse history). The write-back (set moderation_status) and the Neo4j MERGE are already idempotent,
-- so this column is the only piece needed to make a job's effects exactly-once.
--
-- The column lives ONLY in this custom migration, NOT the Drizzle schema (apps/api/src/db/schema/misc.ts)
-- — the same choice as the 0001_postgis geography columns: only the scorer worker (raw asyncpg) reads or
-- writes it; the API's Drizzle never touches it, so keeping it out of the TS schema avoids drift.
-- Idempotent (add column / create index if not exists).

alter table moderation_analyses add column if not exists source_msg_id bigint;
--> statement-breakpoint
create unique index if not exists moderation_analyses_source_msg_idx
  on moderation_analyses (source_msg_id) where source_msg_id is not null;
