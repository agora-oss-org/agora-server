-- GoTrue database role for a Postgres that is NOT the supabase/postgres image (plain postgres:17,
-- Crunchy, Tembo, a self-built image …). Run ONCE as a SUPERUSER, connected to the Agora database,
-- AFTER scripts/bootstrap-supabase-compat.sql and BEFORE the first `gotrue` start:
--
--   psql "postgres://<superuser>@<host>/<agora-db>" -v ON_ERROR_STOP=1 \
--     -v gotrue_password='<strong password>' -f scripts/bootstrap-gotrue-role.sql
--
-- Then point the gotrue service at it:
--   GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:<that password>@<host>:5432/<agora-db>
--
-- Why this exists: the supabase/postgres image ships a ready-made `supabase_auth_admin` role, and
-- the `selfhost` compose profile only has to give it a password (deploy/db/init-auth-role.sql). A
-- plain Postgres has no such role, and the naive fix — CREATE ROLE + GRANT on the `auth` schema —
-- is NOT enough. GoTrue self-migrates its tables at boot and fails twice on the way, verified against
-- postgres:17-alpine seeded like a real deploy (an app-owned `auth` schema + the stub auth.uid()):
--
--   1. "permission denied for schema public" — GoTrue creates its `schema_migrations` bookkeeping
--      table wherever search_path points, which defaults to `public`. Pin the role's search_path.
--   2. "must be owner of function uid" — GoTrue's 00_init_auth_schema ships its OWN auth.uid() and
--      CREATE OR REPLACE requires ownership. Hand it the schema and every function already in it.
--
-- Verified result: GoTrue creates its 16 tables in `auth`, nothing lands in `public`, and the app
-- role can still EXECUTE auth.uid() (the RLS policies from migration 0017 keep working).
--
-- Idempotent: safe to re-run (the role is created only if absent; the password is (re)set either way).
-- Rollback (only before GoTrue has created its tables):
--   ALTER SCHEMA auth OWNER TO <previous owner>; ALTER FUNCTION auth.uid() OWNER TO <previous owner>;
--   DROP ROLE supabase_auth_admin;

\set ON_ERROR_STOP on

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login;
  end if;
end $$;

alter role supabase_auth_admin with password :'gotrue_password';

-- (1) keep GoTrue's bookkeeping table out of `public`
alter role supabase_auth_admin set search_path to auth;

-- (2) GoTrue must own the schema + every existing function in it to run its own migrations
grant create, usage on schema auth to supabase_auth_admin;
alter schema auth owner to supabase_auth_admin;
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth'
  loop
    execute format('alter function %s owner to supabase_auth_admin', r.sig);
  end loop;
end $$;

-- The ownership move revokes nothing, but be explicit: the API (as its own role) and the RLS
-- policies still resolve auth.uid(). PUBLIC covers whatever role your DATABASE_URL uses, matching
-- bootstrap-supabase-compat.sql.
grant usage on schema auth to public;
