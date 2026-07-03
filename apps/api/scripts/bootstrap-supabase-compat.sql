-- Supabase-compat bootstrap for a VANILLA Postgres (e.g. postgres:bookworm) that is NOT the
-- supabase/postgres image. Provisions the roles + `auth` schema + extensions the Agora migrations
-- assume already exist. Run ONCE as a SUPERUSER, connected to the Agora database, BEFORE
-- scripts/genesis.mjs (or drop.mjs/migrate.mjs).
--
--   psql "postgres://<superuser>@<host>/<agora-db>" -v ON_ERROR_STOP=1 -f scripts/bootstrap-supabase-compat.sql
--
-- Must be a SUPERUSER because CREATE EXTENSION for non-trusted extensions (vector/postgis/pgmq)
-- requires it — the app's own (non-superuser) role can't, and shouldn't be made one on a shared box.
-- Connect to the ACTUAL Agora database (not `postgres`): extensions are per-database.
--
-- Why: migrations 0008/0017 `GRANT … TO anon, authenticated` and drop.mjs grants to service_role;
-- 0017's RLS policies call auth.uid(); 0000/0001/0007/0027 create pgcrypto/vector/postgis/pgmq and
-- `SET search_path TO public, extensions`. On the supabase/postgres image these all ship
-- pre-provisioned. None of the RLS/grants is load-bearing here — the Agora server connects as the
-- owner role and BYPASSES RLS (defense-in-depth) — but the DDL must still execute without erroring.
--
-- Idempotent + genesis-safe: drop.mjs only drops private/drizzle/public, never `auth`, these roles,
-- or the `extensions`/`pgmq` schemas — so this survives genesis re-runs. Run it once per fresh
-- database; the migrations' `CREATE EXTENSION IF NOT EXISTS` then no-op (no superuser needed at
-- migrate time). The extension PACKAGES must already be installed in the Postgres image — this only
-- CREATEs them; it can't install missing binaries (`postgresql-NN-postgis-3`, pgmq, pgvector).

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

-- 0017's RLS policies + private.current_profile_ids() reference auth.uid(). This is the CURRENT
-- Supabase definition, not the legacy `request.jwt.claim.sub`-only form: PostgREST replaced the
-- per-claim GUCs with a single `request.jwt.claims` JSON GUC, so real auth.uid() coalesces both.
-- Never actually invoked on this deploy (the server connects as the owner role and bypasses RLS),
-- but staying faithful means any leaked-key / RLS path behaves exactly like Supabase.
create or replace function auth.uid() returns uuid
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

-- The app connects as a NON-superuser owner role that is NOT a member of anon/authenticated/
-- service_role, and migration 0017 creates a `language sql` function whose body is validated at
-- CREATE time and references auth.uid() — so the creating role needs USAGE on `auth` (schema usage
-- is not granted by default), or the migration dies with "permission denied for schema auth". Grant
-- to PUBLIC so it works whatever role your DATABASE_URL uses (auth.uid() only reads a GUC — nothing
-- sensitive). EXECUTE on the function is already PUBLIC by default; stated explicitly for clarity.
grant usage on schema auth to public;
grant execute on function auth.uid() to public;

-- ── Extensions ───────────────────────────────────────────────────────────────────────────────────
-- 0000/0001/0007 create pgcrypto/vector/postgis and 0027 creates pgmq; every migration
-- `SET search_path TO public, extensions` — i.e. they assume the Supabase layout where extensions
-- live in a dedicated `extensions` schema. Pre-create them here (superuser) so the app role's
-- `CREATE EXTENSION IF NOT EXISTS` no-ops at migrate time (non-trusted extensions need superuser).
-- `extensions` + `pgmq` are NOT dropped by drop.mjs, so they persist across genesis re-runs.
create schema if not exists extensions;
grant usage on schema extensions to public;

create extension if not exists pgcrypto schema extensions;
create extension if not exists vector   schema extensions;
create extension if not exists postgis  schema extensions;
create extension if not exists pgmq;  -- relocatable=false: always pins its own `pgmq` schema

-- postgis reference data (spatial_ref_sys, geometry/geography_columns views) must be readable.
grant select on all tables in schema extensions to public;

-- Resolve unqualified vector()/geography()/ST_* for the app role at RUNTIME (migrations set their own
-- per-txn search_path; this covers the live server + scorer connections). %I = the connected DB.
do $$ begin
  execute format('alter database %I set search_path to public, extensions', current_database());
end $$;

-- pgmq: the enqueue trigger runs as the inserting (app) role and the scorer worker reads as it, so
-- the app role must create the queue table + send/read. Grant on the pgmq schema to public.
grant usage, create on schema pgmq to public;
grant all on all tables    in schema pgmq to public;
grant all on all sequences in schema pgmq to public;
grant execute on all functions in schema pgmq to public;
alter default privileges in schema pgmq grant all on tables    to public;
alter default privileges in schema pgmq grant all on sequences to public;
