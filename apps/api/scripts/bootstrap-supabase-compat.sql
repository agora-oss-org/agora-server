-- Supabase-compat bootstrap for a VANILLA Postgres (e.g. postgres:bookworm) that is NOT the
-- supabase/postgres image. Provisions the roles + `auth` schema the Agora migrations assume already
-- exist. Run ONCE as a superuser BEFORE scripts/genesis.mjs (or drop.mjs/migrate.mjs).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/bootstrap-supabase-compat.sql
--
-- Why: migrations 0008/0017 `GRANT … TO anon, authenticated` and drop.mjs grants to service_role;
-- 0017's RLS policies call auth.uid(). On the supabase/postgres image these ship pre-provisioned.
-- None of it is load-bearing here — the Agora server connects as the owner role and BYPASSES RLS
-- (it's defense-in-depth) — but the DDL must still execute without erroring.
--
-- Idempotent + genesis-safe: drop.mjs recreates `public` but never touches `auth` or these roles,
-- so this survives genesis re-runs. You run it once per fresh database.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;

-- 0017's RLS policies call auth.uid(). A stable shim reading the JWT `sub` claim satisfies policy
-- creation/execution. Never actually invoked on this deploy (owner role bypasses RLS).
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
