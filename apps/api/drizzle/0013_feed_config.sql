-- Per-project feed ranking config (algorithm + tunables + optional re-rank webhook).
-- Idempotent: safe to re-run. The resolved shape + defaults live in server/src/lib/feed-config.ts.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS feed_config jsonb NOT NULL DEFAULT '{}'::jsonb;
