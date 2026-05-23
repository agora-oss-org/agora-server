-- Agora 0003 — spaces, space_members, rules, follows, connections

create table spaces (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects(id) on delete cascade,
  short_id            text not null,
  slug                text,
  name                text not null,
  description         text,
  avatar_file_id      uuid,
  banner_file_id      uuid,
  user_id             uuid references profiles(id) on delete set null,  -- creator/owner
  reading_permission  reading_permission not null default 'anyone',
  posting_permission  posting_permission not null default 'members',
  require_join_approval boolean not null default false,
  parent_space_id     uuid references spaces(id) on delete cascade,
  depth               integer not null default 0,
  metadata            jsonb not null default '{}'::jsonb,
  -- denormalized (triggers in 0006):
  members_count       integer not null default 0,
  child_spaces_count  integer not null default 0,
  -- digest config (GET/PATCH /spaces/:id/digest-config):
  digest_enabled      boolean not null default false,
  digest_webhook_url  text,
  digest_webhook_secret text,
  digest_schedule_hour integer,
  digest_timezone     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (project_id, short_id),
  unique (project_id, slug)
);
create index on spaces (project_id, parent_space_id);

-- now that spaces exists, wire entities.space_id
alter table entities
  add constraint entities_space_fk
  foreign key (space_id) references spaces(id) on delete set null;

create table space_members (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  space_id    uuid not null references spaces(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  role        space_member_role not null default 'member',
  status      space_member_status not null default 'active',
  joined_at   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (space_id, user_id)
);
create index on space_members (space_id, status);
create index on space_members (user_id);

create table space_rules (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  space_id         uuid not null references spaces(id) on delete cascade,
  title            text not null,
  description      text,
  "order"          integer not null default 0,
  last_approved_by uuid references profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on space_rules (space_id, "order");

-- ─── Follows (one-directional) ───────────────────────────────────────────────
create table follows (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  follower_id  uuid not null references profiles(id) on delete cascade,
  followed_id  uuid not null references profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (project_id, follower_id, followed_id),
  check (follower_id <> followed_id)
);
create index on follows (followed_id);   -- followers-of lookups
create index on follows (follower_id);    -- following-of lookups

-- ─── Connections (bi-directional, state machine) ─────────────────────────────
-- requester → addressee. status: pending → connected | declined.
create table connections (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  requester_id uuid not null references profiles(id) on delete cascade,
  addressee_id uuid not null references profiles(id) on delete cascade,
  status       connection_status not null default 'pending',
  message      text,
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  unique (project_id, requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index on connections (project_id, addressee_id, status);
create index on connections (project_id, requester_id, status);
