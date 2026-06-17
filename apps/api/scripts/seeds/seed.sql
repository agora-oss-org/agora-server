-- Agora validation + dev seed. Deterministic fixed UUIDs so handler work can reference them.
-- Every step asserts the trigger/RPC behaviour; the whole thing runs in one transaction so a
-- failed ASSERT rolls back (no partial seed) and surfaces loudly. On success the rows persist.
--
-- Run:  url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seeds/seed.sql
--
-- Fixed ids:
--   project   11111111-1111-1111-1111-111111111111
--   alice     aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa   bob  bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
--   entity    e1111111-1111-1111-1111-111111111111
--   comment   c1111111-1111-1111-1111-111111111111   reply c2222222-2222-2222-2222-222222222222
--   space     51111111-1111-1111-1111-111111111111   child 52222222-2222-2222-2222-222222222222
--   convo     d1111111-1111-1111-1111-111111111111   msg   f1111111-1111-1111-1111-111111111111
--   threadmsg f2222222-2222-2222-2222-222222222222   collection c0111111-1111-1111-1111-111111111111

begin;

-- ── project + profiles ───────────────────────────────────────────────────────
insert into projects (id, client_id, name)
  values ('11111111-1111-1111-1111-111111111111', 'seed-client', 'Agora Seed')
  on conflict (id) do nothing;

insert into profiles (id, project_id, username, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'alice', 'Alice'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'bob', 'Bob')
  on conflict (id) do nothing;

-- ── entity by alice ──────────────────────────────────────────────────────────
insert into entities (id, project_id, user_id, short_id, content)
  values ('e1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ent1', 'hello, world')
  on conflict (id) do nothing;

do $$ begin
  assert (select reaction_counts->>'upvote' from entities where id='e1111111-1111-1111-1111-111111111111')='0', 'entity upvote should start 0';
  assert (select replies_count from entities where id='e1111111-1111-1111-1111-111111111111')=0, 'entity replies should start 0';
end $$;

-- ── reaction toggle: bob upvotes alice's entity ──────────────────────────────
select toggle_reaction('11111111-1111-1111-1111-111111111111','entity',
                        'e1111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','upvote');
do $$ begin
  assert (select reaction_counts->>'upvote' from entities where id='e1111111-1111-1111-1111-111111111111')='1', 'upvote count should be 1';
  assert (select reputation from profiles where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')=1, 'alice reputation should be +1';
end $$;

-- toggle again clears it
select toggle_reaction('11111111-1111-1111-1111-111111111111','entity',
                        'e1111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','upvote');
do $$ begin
  assert (select reaction_counts->>'upvote' from entities where id='e1111111-1111-1111-1111-111111111111')='0', 'upvote should clear to 0';
  assert (select reputation from profiles where id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')=0, 'alice reputation back to 0';
end $$;

-- ── threaded comments ────────────────────────────────────────────────────────
insert into comments (id, project_id, entity_id, user_id, content) values
  ('c1111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
   'e1111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Top comment')
  on conflict (id) do nothing;
insert into comments (id, project_id, entity_id, user_id, parent_id, content) values
  ('c2222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
   'e1111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'c1111111-1111-1111-1111-111111111111','A reply')
  on conflict (id) do nothing;
do $$ begin
  assert (select replies_count from entities where id='e1111111-1111-1111-1111-111111111111')=2, 'entity replies should be 2';
  assert (select replies_count from comments where id='c1111111-1111-1111-1111-111111111111')=1, 'parent comment replies should be 1';
  assert (select count(*) from fetch_comment_thread('e1111111-1111-1111-1111-111111111111'))=2, 'thread should return 2 rows';
end $$;

-- ── spaces + members + child ─────────────────────────────────────────────────
insert into spaces (id, project_id, user_id, short_id, name) values
  ('51111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','spc1','General')
  on conflict (id) do nothing;
insert into space_members (project_id, space_id, user_id, role, status) values
  ('11111111-1111-1111-1111-111111111111','51111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','admin','active'),
  ('11111111-1111-1111-1111-111111111111','51111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','member','active')
  on conflict (space_id, user_id) do nothing;
insert into spaces (id, project_id, user_id, short_id, name, parent_space_id, depth) values
  ('52222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','spc2','Sub', '51111111-1111-1111-1111-111111111111', 1)
  on conflict (id) do nothing;
do $$ begin
  assert (select members_count from spaces where id='51111111-1111-1111-1111-111111111111')=2, 'space members should be 2';
  assert (select child_spaces_count from spaces where id='51111111-1111-1111-1111-111111111111')=1, 'space child count should be 1';
end $$;

-- ── conversation + message + threaded reply ──────────────────────────────────
insert into conversations (id, project_id, type, name, created_by_id) values
  ('d1111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','group','Chat','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  on conflict (id) do nothing;
insert into conversation_members (project_id, conversation_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','d1111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','admin'),
  ('11111111-1111-1111-1111-111111111111','d1111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','member')
  on conflict (conversation_id, user_id) do nothing;
insert into chat_messages (id, project_id, conversation_id, user_id, content) values
  ('f1111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','d1111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Hi there')
  on conflict (id) do nothing;
insert into chat_messages (id, project_id, conversation_id, user_id, parent_message_id, content) values
  ('f2222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','d1111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','f1111111-1111-1111-1111-111111111111','A reply')
  on conflict (id) do nothing;
do $$ begin
  assert (select last_message_at from conversations where id='d1111111-1111-1111-1111-111111111111') is not null, 'conversation last_message_at should be set';
  assert (select thread_reply_count from chat_messages where id='f1111111-1111-1111-1111-111111111111')=1, 'parent message thread count should be 1';
end $$;

-- ── collection + saved entity ────────────────────────────────────────────────
insert into collections (id, project_id, user_id, name) values
  ('c0111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Favourites')
  on conflict (id) do nothing;
insert into collection_entities (collection_id, entity_id) values
  ('c0111111-1111-1111-1111-111111111111','e1111111-1111-1111-1111-111111111111')
  on conflict (collection_id, entity_id) do nothing;
do $$ begin
  assert (select entity_count from collections where id='c0111111-1111-1111-1111-111111111111')=1, 'collection entity_count should be 1';
end $$;

-- ── score + semantic-search smoke ────────────────────────────────────────────
-- Re-add bob's upvote (final seed state: entity has 1 upvote), then recompute score.
select toggle_reaction('11111111-1111-1111-1111-111111111111','entity',
                        'e1111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','upvote');
select refresh_entity_score('e1111111-1111-1111-1111-111111111111');
do $$ declare n int; begin
  assert (select score from entities where id='e1111111-1111-1111-1111-111111111111') <> 0, 'score should be non-zero after refresh';
  -- match_entities executes (no embeddings yet -> 0 rows, no error)
  select count(*) into n from match_entities('11111111-1111-1111-1111-111111111111', array_fill(0::float8, array[1536])::vector, 5);
  assert n = 0, 'match_entities should run and return 0 rows (no embeddings)';
end $$;

commit;

\echo '✅ All seed assertions passed — triggers + RPC validated, seed data persisted.'
