-- Durable "needs embedding" flag for the outbound Voyage embed throttle (lib/embed-throttle.ts).
-- Write-path embeds skipped while a project's breaker is tripped land here instead of dropping; the
-- drain cron (/internal/cron/drain-embeddings) replays them into content_embeddings. Idempotent.
CREATE TABLE IF NOT EXISTS "pending_embeddings" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "source_type" text NOT NULL,
  "source_id" uuid NOT NULL,
  "text" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "pending_embeddings_pkey" PRIMARY KEY ("source_type", "source_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_embeddings_drain_idx" ON "pending_embeddings" ("project_id", "created_at");
--> statement-breakpoint
-- New table ships its own RLS deny-all (0017's enablement was one-time). No policies -> deny-all for
-- non-owner roles; the server connects as the RLS-bypassing owner, so this is defense-in-depth.
ALTER TABLE "pending_embeddings" ENABLE ROW LEVEL SECURITY;
