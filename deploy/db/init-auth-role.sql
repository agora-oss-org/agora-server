-- Runs ONCE at first initialization of a fresh db volume (docker-entrypoint-initdb.d).
-- The supabase/postgres image creates the supabase_auth_admin role but does NOT give it a
-- password derived from POSTGRES_PASSWORD — without this, the bundled GoTrue (selfhost SSO)
-- crash-loops on "password authentication failed for user supabase_auth_admin".
-- psql expands the backtick command, so the password never lands in the image or repo.
-- (Same pattern as the official Supabase self-host bundle's 99-roles.sql.)
--
-- Existing volumes initialized BEFORE this file was added need the one-time equivalent by hand:
--   docker compose exec db psql -h 127.0.0.1 -U supabase_admin -d postgres \
--     -c "alter role supabase_auth_admin password '<POSTGRES_PASSWORD>'"
\set pgpass `echo "$POSTGRES_PASSWORD"`
alter role supabase_auth_admin with password :'pgpass';
