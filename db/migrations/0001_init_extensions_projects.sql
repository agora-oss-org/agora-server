-- Agora 0001 — extensions, enums, projects, profiles
-- Foundation: Supabase Postgres. The API server talks to this with the service-role key;
-- RLS is enabled as defense-in-depth (policies in 0008_rls.sql).

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "vector";     -- pgvector: semantic search (/search/content)
create extension if not exists "postgis";    -- GeoJSON Point on entities/users (location filters)

-- ─── Enums (mirror @replyke/core types) ──────────────────────────────────────
create type user_role          as enum ('admin','moderator','visitor');
create type reaction_type       as enum ('upvote','downvote','like','love','wow','sad','angry','funny');
create type reaction_target     as enum ('entity','comment');
create type moderation_status   as enum ('approved','removed');
create type moderated_by_type   as enum ('client','user');
create type reading_permission  as enum ('anyone','members');
create type posting_permission  as enum ('anyone','members','admins');
create type space_member_role   as enum ('admin','moderator','member');
create type space_member_status as enum ('pending','active','banned','rejected');
create type conversation_type   as enum ('direct','group','space');
create type conv_member_role     as enum ('admin','member');
create type connection_status   as enum ('pending','connected','declined');

-- ─── Projects ────────────────────────────────────────────────────────────────
-- The SDK addresses every route as /v7/:projectId/... ; projectId is the tenant key.
create table projects (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  name        text not null,
  -- per-project RS256 public key for external-auth JWT verification
  external_auth_public_key text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table project_integrations (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ─── Profiles (Replyke "User"; auth lives in Supabase auth.users) ─────────────
-- One profile per (project, auth user). foreign_id maps to the host app's user id.
create table profiles (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  auth_user_id    uuid references auth.users(id) on delete set null, -- null for external-auth-only users
  foreign_id      text,
  role            user_role not null default 'visitor',
  email           text,
  name            text,
  username        text,
  avatar          text,
  avatar_file_id  uuid,
  banner_file_id  uuid,
  bio             text check (char_length(bio) <= 300),
  birthdate       date,
  location        geography(Point, 4326),
  metadata        jsonb not null default '{}'::jsonb,        -- ≤10KB (enforce in app)
  secure_metadata jsonb not null default '{}'::jsonb,        -- never serialized to public User
  reputation      integer not null default 0,
  is_verified     boolean not null default false,
  is_active       boolean not null default true,
  last_active     timestamptz not null default now(),
  auth_methods    text[] not null default '{}',              -- ['password','google',...]
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, username),
  unique (project_id, foreign_id)
);
create index on profiles (project_id, username);
create index on profiles (project_id, foreign_id);

-- user suspensions (AuthUser.suspensions[])
create table user_suspensions (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  reason      text,
  start_date  timestamptz not null default now(),
  end_date    timestamptz
);

-- oauth identities (GET/DELETE /oauth/identities)
create table oauth_identities (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  profile_id   uuid not null references profiles(id) on delete cascade,
  provider     text not null,           -- google, github, ...
  provider_uid text not null,
  created_at   timestamptz not null default now(),
  unique (project_id, provider, provider_uid)
);
