-- Agora 0002 — entities, comments, reactions
-- Vote tallies (reaction_counts) and replies_count are DENORMALIZED and kept current by
-- triggers (0006). Never recompute per request.

create table entities (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  foreign_id      text,
  short_id        text not null,                 -- generated; for share links
  source_id       text,
  space_id        uuid,                           -- fk added in 0003 (spaces defined later)
  user_id         uuid references profiles(id) on delete set null,
  title           text,
  content         text,
  mentions        jsonb not null default '[]'::jsonb,
  attachments     jsonb not null default '[]'::jsonb,
  keywords        text[] not null default '{}',
  -- v6 legacy arrays kept for SDK compatibility alongside v7 counts:
  upvotes         text[] not null default '{}',
  downvotes       text[] not null default '{}',
  -- v7 denormalized reaction counts (one key per reaction_type):
  reaction_counts jsonb not null default
    '{"upvote":0,"downvote":0,"like":0,"love":0,"wow":0,"sad":0,"angry":0,"funny":0}'::jsonb,
  replies_count   integer not null default 0,
  views           integer not null default 0,
  score           double precision not null default 0,   -- hotness; maintained by trigger/cron
  score_updated_at timestamptz not null default now(),
  location        geography(Point, 4326),
  metadata        jsonb not null default '{}'::jsonb,
  is_draft        boolean default false,
  moderation_status moderation_status,
  moderated_at    timestamptz,
  moderated_by_id uuid references profiles(id) on delete set null,
  moderated_by_type moderated_by_type,
  moderation_reason text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (project_id, short_id),
  unique (project_id, foreign_id)
);
create index on entities (project_id, space_id, score desc);          -- hot feed
create index on entities (project_id, space_id, created_at desc);      -- new feed
create index on entities (project_id, user_id);
create index on entities using gin (keywords);
create index on entities using gin (metadata jsonb_path_ops);
create index on entities using gist (location);

create table comments (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  foreign_id      text,
  entity_id       uuid not null references entities(id) on delete cascade,
  user_id         uuid references profiles(id) on delete set null,
  parent_id       uuid references comments(id) on delete cascade,
  content         text,
  gif             jsonb,
  mentions        jsonb not null default '[]'::jsonb,
  upvotes         text[] not null default '{}',   -- v6 legacy
  downvotes       text[] not null default '{}',   -- v6 legacy
  reaction_counts jsonb not null default
    '{"upvote":0,"downvote":0,"like":0,"love":0,"wow":0,"sad":0,"angry":0,"funny":0}'::jsonb,
  replies_count   integer not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  moderation_status moderation_status,
  moderated_at    timestamptz,
  moderated_by_id uuid references profiles(id) on delete set null,
  moderated_by_type moderated_by_type,
  moderation_reason text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,            -- soft delete
  user_deleted_at timestamptz             -- Reddit-style "[deleted]" placeholder
);
-- threaded fetch: comments of an entity, by parent, chronological
create index on comments (project_id, entity_id, parent_id, created_at);
create index on comments (parent_id);
create index on comments (user_id);

-- Normalized reaction rows. reaction_counts on entity/comment are derived from these.
create table reactions (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  target_type  reaction_target not null,
  target_id    uuid not null,
  user_id      uuid not null references profiles(id) on delete cascade,
  reaction_type reaction_type not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- one reaction per user per target (changing reaction = update row)
  unique (project_id, target_type, target_id, user_id)
);
create index on reactions (target_type, target_id);
create index on reactions (user_id);
