-- Triggers: atomic denormalized counts + reputation. Idempotent
-- (create or replace functions; drop trigger if exists before create).

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
--> statement-breakpoint
do $$ declare t text;
begin
  foreach t in array array['profiles','entities','comments','spaces','conversations',
                           'conversation_members','chat_messages','collections','space_rules',
                           'projects','reactions','files']
  loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s', t);
    execute format('create trigger trg_touch_%1$s before update on %1$s
                    for each row execute function touch_updated_at()', t);
  end loop;
end $$;
--> statement-breakpoint
create or replace function reaction_reputation(rt reaction_type) returns int
language sql immutable as $$
  select case rt
    when 'upvote' then 1 when 'downvote' then -1 when 'like' then 1 when 'love' then 2
    when 'wow' then 1 when 'funny' then 1 else 0 end $$;
--> statement-breakpoint
create or replace function bump_reaction_count(
  p_target reaction_target, p_id uuid, p_type reaction_type, p_delta int
) returns void language plpgsql as $$
begin
  if p_target = 'entity' then
    update entities set reaction_counts =
      jsonb_set(reaction_counts, array[p_type::text],
                to_jsonb(greatest(0, coalesce((reaction_counts->>p_type::text)::int,0) + p_delta)))
    where id = p_id;
  else
    update comments set reaction_counts =
      jsonb_set(reaction_counts, array[p_type::text],
                to_jsonb(greatest(0, coalesce((reaction_counts->>p_type::text)::int,0) + p_delta)))
    where id = p_id;
  end if;
end $$;
--> statement-breakpoint
create or replace function reaction_author(p_target reaction_target, p_id uuid) returns uuid
language sql stable as $$
  select case when p_target='entity' then (select user_id from entities where id=p_id)
              else (select user_id from comments where id=p_id) end $$;
--> statement-breakpoint
create or replace function on_reaction_change() returns trigger language plpgsql as $$
declare author uuid;
begin
  if (tg_op = 'INSERT') then
    perform bump_reaction_count(new.target_type, new.target_id, new.reaction_type, 1);
    author := reaction_author(new.target_type, new.target_id);
    if author is not null then
      update profiles set reputation = reputation + reaction_reputation(new.reaction_type) where id = author;
    end if;
  elsif (tg_op = 'DELETE') then
    perform bump_reaction_count(old.target_type, old.target_id, old.reaction_type, -1);
    author := reaction_author(old.target_type, old.target_id);
    if author is not null then
      update profiles set reputation = reputation - reaction_reputation(old.reaction_type) where id = author;
    end if;
  elsif (tg_op = 'UPDATE' and new.reaction_type <> old.reaction_type) then
    perform bump_reaction_count(old.target_type, old.target_id, old.reaction_type, -1);
    perform bump_reaction_count(new.target_type, new.target_id, new.reaction_type, 1);
    author := reaction_author(new.target_type, new.target_id);
    if author is not null then
      update profiles set reputation = reputation
        - reaction_reputation(old.reaction_type) + reaction_reputation(new.reaction_type)
      where id = author;
    end if;
  end if;
  return null;
end $$;
--> statement-breakpoint
drop trigger if exists trg_reaction_change on reactions;
--> statement-breakpoint
create trigger trg_reaction_change after insert or update or delete on reactions
  for each row execute function on_reaction_change();
--> statement-breakpoint
create or replace function on_comment_change() returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    update entities set replies_count = replies_count + 1 where id = new.entity_id;
    if new.parent_id is not null then
      update comments set replies_count = replies_count + 1 where id = new.parent_id;
    end if;
  elsif (tg_op = 'DELETE') then
    update entities set replies_count = greatest(0, replies_count - 1) where id = old.entity_id;
    if old.parent_id is not null then
      update comments set replies_count = greatest(0, replies_count - 1) where id = old.parent_id;
    end if;
  end if;
  return null;
end $$;
--> statement-breakpoint
drop trigger if exists trg_comment_change on comments;
--> statement-breakpoint
create trigger trg_comment_change after insert or delete on comments
  for each row execute function on_comment_change();
--> statement-breakpoint
create or replace function on_space_member_change() returns trigger language plpgsql as $$
begin
  if (tg_op='INSERT' and new.status='active') then
    update spaces set members_count = members_count + 1 where id = new.space_id;
  elsif (tg_op='DELETE' and old.status='active') then
    update spaces set members_count = greatest(0, members_count - 1) where id = old.space_id;
  elsif (tg_op='UPDATE' and new.status<>old.status) then
    if new.status='active' then update spaces set members_count = members_count + 1 where id = new.space_id;
    elsif old.status='active' then update spaces set members_count = greatest(0, members_count - 1) where id = new.space_id;
    end if;
  end if;
  return null;
end $$;
--> statement-breakpoint
drop trigger if exists trg_space_member_change on space_members;
--> statement-breakpoint
create trigger trg_space_member_change after insert or update or delete on space_members
  for each row execute function on_space_member_change();
--> statement-breakpoint
create or replace function on_space_change() returns trigger language plpgsql as $$
begin
  if (tg_op='INSERT' and new.parent_space_id is not null) then
    update spaces set child_spaces_count = child_spaces_count + 1 where id = new.parent_space_id;
  elsif (tg_op='DELETE' and old.parent_space_id is not null) then
    update spaces set child_spaces_count = greatest(0, child_spaces_count - 1) where id = old.parent_space_id;
  end if;
  return null;
end $$;
--> statement-breakpoint
drop trigger if exists trg_space_change on spaces;
--> statement-breakpoint
create trigger trg_space_change after insert or delete on spaces
  for each row execute function on_space_change();
--> statement-breakpoint
create or replace function on_chat_message_insert() returns trigger language plpgsql as $$
begin
  update conversations set last_message_at = new.created_at where id = new.conversation_id;
  if new.parent_message_id is not null then
    update chat_messages set thread_reply_count = thread_reply_count + 1 where id = new.parent_message_id;
  end if;
  return null;
end $$;
--> statement-breakpoint
drop trigger if exists trg_chat_message_insert on chat_messages;
--> statement-breakpoint
create trigger trg_chat_message_insert after insert on chat_messages
  for each row execute function on_chat_message_insert();
--> statement-breakpoint
create or replace function on_collection_entity_change() returns trigger language plpgsql as $$
begin
  if (tg_op='INSERT') then
    update collections set entity_count = entity_count + 1 where id = new.collection_id;
  elsif (tg_op='DELETE') then
    update collections set entity_count = greatest(0, entity_count - 1) where id = old.collection_id;
  end if;
  return null;
end $$;
--> statement-breakpoint
drop trigger if exists trg_collection_entity_change on collection_entities;
--> statement-breakpoint
create trigger trg_collection_entity_change after insert or delete on collection_entities
  for each row execute function on_collection_entity_change();
