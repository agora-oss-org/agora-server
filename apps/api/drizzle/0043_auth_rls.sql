-- RLS deny-all backstop for the native-auth tables added in 0041. The 0017 enablement
-- loop only covered tables existing at that migration (it is a one-time DO block, not an
-- event trigger), so these must be enabled explicitly. No policies → deny-all for
-- non-privileged roles; the server connects as an RLS-bypassing owner, so this is pure
-- defense-in-depth for the most sensitive rows (password + token hashes). Idempotent:
-- enabling RLS is a no-op if already on.
ALTER TABLE "auth_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ENABLE ROW LEVEL SECURITY;
