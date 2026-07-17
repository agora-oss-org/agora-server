-- 0064: auth wall — private by default.
-- Design: docs/superpowers/specs/2026-07-17-auth-wall-private-by-default-design.md
-- The API now requires an authenticated account for every read (the authWall middleware), so the
-- direct anon-key read path (0008 "Option A", a never-used performance seam) has no remaining
-- legitimate caller. Drop every *_public_read policy and revoke anon's SELECT. The authenticated
-- role keeps its GRANTs (harmless: the 0017 deny-all backstop denies without a policy) and its
-- self-access policies from later migrations. Idempotent.
DROP POLICY IF EXISTS "spaces_public_read" ON "spaces";
--> statement-breakpoint
DROP POLICY IF EXISTS "entities_public_read" ON "entities";
--> statement-breakpoint
DROP POLICY IF EXISTS "comments_public_read" ON "comments";
--> statement-breakpoint
DROP POLICY IF EXISTS "space_rules_public_read" ON "space_rules";
--> statement-breakpoint
DROP POLICY IF EXISTS "follows_public_read" ON "follows";
--> statement-breakpoint
DROP POLICY IF EXISTS "reactions_public_read" ON "reactions";
--> statement-breakpoint
REVOKE SELECT ON "spaces", "entities", "comments", "space_rules", "follows", "reactions" FROM anon;
