-- Idempotent enum extension (PG12+ allows ADD VALUE inside a tx; new value usable after commit).
ALTER TYPE "public"."reaction_target" ADD VALUE IF NOT EXISTS 'message';