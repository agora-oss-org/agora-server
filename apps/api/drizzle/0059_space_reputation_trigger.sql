-- apps/api/drizzle/0059_space_reputation_trigger.sql
-- Maintain space_reputation from the reaction trigger. Resolves the space a reaction target lives in
-- (entity → its space_id; comment → its ROOT entity's space_id; message/feed-level → null = no space),
-- and upserts the author's per-space score alongside the existing global profiles.reputation bump.
-- Idempotent (create or replace); the 0002 trigger already points at on_reaction_change().
SET search_path TO public, extensions;
--> statement-breakpoint
create or replace function content_space_id(p_target reaction_target, p_id uuid)
returns uuid language sql stable as $$
  select case
    when p_target = 'entity'  then (select space_id from entities where id = p_id)
    when p_target = 'comment' then (select e.space_id from comments c
                                      join entities e on e.id = c.entity_id
                                      where c.id = p_id)
    else null
  end $$;
--> statement-breakpoint
create or replace function bump_space_reputation(
  p_project uuid, p_target reaction_target, p_id uuid, p_author uuid, p_delta int
) returns void language plpgsql as $$
declare sid uuid;
begin
  if p_author is null or p_delta = 0 then return; end if;
  sid := content_space_id(p_target, p_id);
  if sid is null then return; end if;
  insert into space_reputation (project_id, space_id, user_id, reputation)
    values (p_project, sid, p_author, p_delta)
  on conflict (project_id, space_id, user_id)
    do update set reputation = space_reputation.reputation + p_delta;
end $$;
--> statement-breakpoint
create or replace function on_reaction_change() returns trigger language plpgsql as $$
declare author uuid;
begin
  if (tg_op = 'INSERT') then
    perform bump_reaction_count(new.target_type, new.target_id, new.reaction_type, 1);
    author := reaction_author(new.target_type, new.target_id);
    if author is not null then
      update profiles set reputation = reputation + reaction_reputation(new.reaction_type) where id = author;
      perform bump_space_reputation(new.project_id, new.target_type, new.target_id, author,
                                    reaction_reputation(new.reaction_type));
    end if;
  elsif (tg_op = 'DELETE') then
    perform bump_reaction_count(old.target_type, old.target_id, old.reaction_type, -1);
    author := reaction_author(old.target_type, old.target_id);
    if author is not null then
      update profiles set reputation = reputation - reaction_reputation(old.reaction_type) where id = author;
      perform bump_space_reputation(old.project_id, old.target_type, old.target_id, author,
                                    -reaction_reputation(old.reaction_type));
    end if;
  elsif (tg_op = 'UPDATE' and new.reaction_type <> old.reaction_type) then
    perform bump_reaction_count(old.target_type, old.target_id, old.reaction_type, -1);
    perform bump_reaction_count(new.target_type, new.target_id, new.reaction_type, 1);
    author := reaction_author(new.target_type, new.target_id);
    if author is not null then
      update profiles set reputation = reputation
        - reaction_reputation(old.reaction_type) + reaction_reputation(new.reaction_type)
      where id = author;
      perform bump_space_reputation(new.project_id, new.target_type, new.target_id, author,
                                    reaction_reputation(new.reaction_type) - reaction_reputation(old.reaction_type));
    end if;
  end if;
  return null;
end $$;
