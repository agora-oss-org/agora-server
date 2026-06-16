-- RLS deny-all backstop for project_roles (0017's enablement was a one-time DO block; new tables
-- ship their own). No policies -> deny-all for non-owner roles; the server connects as the
-- RLS-bypassing owner, so this is defense-in-depth. Idempotent: enabling RLS twice is a no-op.
ALTER TABLE "project_roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Backfill: every existing steward grant becomes a project_roles(role='steward') row. Idempotent via
-- the unique(project_id, profile_id, role). Preserves granted_by_id + created_at so the audit survives.
INSERT INTO "project_roles" ("project_id", "profile_id", "role", "granted_by_id", "created_at")
SELECT "project_id", "profile_id", 'steward'::"project_role", "granted_by_id", "created_at"
FROM "project_stewards"
ON CONFLICT ("project_id", "profile_id", "role") DO NOTHING;
