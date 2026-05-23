-- Agora 0004 — chat: conversations, members, messages, message reactions
-- Realtime delivery is socket.io (see docs/MANIFEST.md §4); these tables are the durable store.

create table conversations (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  type            conversation_type not null,
  name            text,
  description     text,
  space_id        uuid references spaces(id) on delete cascade,   -- for type='space'
  created_by_id   uuid references profiles(id) on delete set null,
  avatar_file_id  uuid,
  last_message_at timestamptz,                                     -- denormalized (trigger)
  posting_permission text check (posting_permission in ('members','admins')),
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on conversations (project_id, last_message_at desc);
create index on conversations (space_id);

create table conversation_members (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id         uuid not null references profiles(id) on delete cascade,
  role            conv_member_role,
  last_read_at    timestamptz,           -- drives unreadCount
  muted_until     timestamptz,
  is_active       boolean not null default true,
  left_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (conversation_id, user_id)
);
create index on conversation_members (user_id, is_active);

create table chat_messages (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  conversation_id   uuid not null references conversations(id) on delete cascade,
  user_id           uuid references profiles(id) on delete set null,
  content           text,
  gif               jsonb,
  mentions          jsonb not null default '[]'::jsonb,
  metadata          jsonb not null default '{}'::jsonb,
  parent_message_id uuid references chat_messages(id) on delete set null,
  quoted_message_id uuid references chat_messages(id) on delete set null,
  thread_reply_count integer not null default 0,         -- denormalized (trigger)
  reaction_counts   jsonb not null default '{}'::jsonb,  -- emoji -> count (free-form, not the 8 types)
  edited_at         timestamptz,
  user_deleted_at   timestamptz,
  moderation_status moderation_status,
  moderated_at      timestamptz,
  moderated_by_id   uuid references profiles(id) on delete set null,
  moderated_by_type moderated_by_type,
  moderation_reason text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index on chat_messages (conversation_id, created_at desc);
create index on chat_messages (parent_message_id);

-- per-user emoji reactions on a message (drives message:reaction socket event)
create table chat_message_reactions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  message_id  uuid not null references chat_messages(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  emoji       text not null,
  created_at  timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);
create index on chat_message_reactions (message_id);
