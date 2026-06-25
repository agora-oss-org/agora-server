-- Self-service account deletion: a third auth_email_tokens kind for the emailed confirmation code.
-- Idempotent enum extension (PG12+ allows ADD VALUE inside a tx; new value usable after commit).
ALTER TYPE "public"."auth_email_token_kind" ADD VALUE IF NOT EXISTS 'delete';
