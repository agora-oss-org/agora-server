-- Agora 0005 — collections, files, app_notifications, reports, search embeddings

-- ─── Collections (saved-entity folders, nestable) ────────────────────────────
create table collections (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  user_id      uuid not null references profiles(id) on delete cascade,
  parent_id    uuid references collections(id) on delete cascade,
  name         text not null,
  entity_count integer not null default 0,          -- denormalized (trigger)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on collections (project_id, user_id, parent_id);

create table collection_entities (
  collection_id uuid not null references collections(id) on delete cascade,
  entity_id     uuid not null references entities(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (collection_id, entity_id)
);

-- ─── Files (Supabase Storage holds bytes; this is the metadata table) ────────
create table files (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects(id) on delete cascade,
  user_id          uuid references profiles(id) on delete set null,
  entity_id        uuid references entities(id) on delete cascade,
  comment_id       uuid references comments(id) on delete cascade,
  chat_message_id  uuid references chat_messages(id) on delete cascade,
  space_id         uuid references spaces(id) on delete cascade,
  type             text not null check (type in ('image','video','document','other')),
  original_path    text not null,
  original_size    bigint not null default 0,
  original_mime_type text,
  position         integer not null default 0,
  metadata         jsonb not null default '{}'::jsonb,
  image            jsonb,                 -- FileImage (variants etc.) when type='image'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on files (entity_id);
create index on files (comment_id);
create index on files (chat_message_id);

-- ─── App notifications (17 types; stored generically) ────────────────────────
create table app_notifications (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,  -- recipient
  type        text not null,
  action      text,
  is_read     boolean not null default false,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index on app_notifications (project_id, user_id, is_read, created_at desc);

-- ─── Reports / moderation queue ──────────────────────────────────────────────
create table reports (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  reporter_id   uuid references profiles(id) on delete set null,
  target_type   reaction_target not null,        -- 'entity' | 'comment'
  target_id     uuid not null,
  space_id      uuid references spaces(id) on delete cascade,
  reason        text not null,                    -- key from reportReasons
  details       text,
  resolved_at   timestamptz,
  resolved_by_id uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index on reports (project_id, space_id, resolved_at);
create index on reports (target_type, target_id);

-- ─── Semantic search embeddings (pgvector; /search/content) ──────────────────
-- Dimension 1536 assumes OpenAI text-embedding-3-small; adjust to your model.
create table entity_embeddings (
  entity_id   uuid primary key references entities(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  embedding   vector(1536),
  updated_at  timestamptz not null default now()
);
create index on entity_embeddings using ivfflat (embedding vector_cosine_ops) with (lists = 100);
