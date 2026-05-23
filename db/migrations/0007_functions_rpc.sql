-- Agora 0007 — RPC: atomic ops + ranking the server calls via supabase.rpc()

-- ─── toggle_reaction: idempotent set/switch/clear of a user's reaction ───────
-- Returns the target's fresh reaction_counts. Counts maintained by 0006 trigger.
create or replace function toggle_reaction(
  p_project uuid, p_target reaction_target, p_target_id uuid, p_user uuid, p_type reaction_type
) returns jsonb language plpgsql as $$
declare existing reaction_type; result jsonb;
begin
  select reaction_type into existing from reactions
    where project_id=p_project and target_type=p_target and target_id=p_target_id and user_id=p_user;

  if existing is null then
    insert into reactions(project_id,target_type,target_id,user_id,reaction_type)
      values (p_project,p_target,p_target_id,p_user,p_type);
  elsif existing = p_type then
    delete from reactions
      where project_id=p_project and target_type=p_target and target_id=p_target_id and user_id=p_user;
  else
    update reactions set reaction_type=p_type, updated_at=now()
      where project_id=p_project and target_type=p_target and target_id=p_target_id and user_id=p_user;
  end if;

  if p_target='entity' then select reaction_counts into result from entities where id=p_target_id;
  else select reaction_counts into result from comments where id=p_target_id; end if;
  return result;
end $$;

-- ─── hot_score: Reddit-style ranking over net votes + age ────────────────────
-- net = upvote+like+love*2+wow+funny - downvote (tunable). Use to maintain entities.score.
create or replace function hot_score(rc jsonb, created timestamptz) returns double precision
language sql immutable as $$
  select
    let.sign * log(greatest(abs(let.net), 1)) + (extract(epoch from created) - 1700000000) / 45000.0
  from (
    select
      ( coalesce((rc->>'upvote')::int,0) + coalesce((rc->>'like')::int,0)
        + coalesce((rc->>'love')::int,0)*2 + coalesce((rc->>'wow')::int,0)
        + coalesce((rc->>'funny')::int,0) - coalesce((rc->>'downvote')::int,0) ) as net,
      case when ( coalesce((rc->>'upvote')::int,0) - coalesce((rc->>'downvote')::int,0) ) >= 0
           then 1 else -1 end as sign
  ) let
$$;

-- recompute score for one entity (call after vote changes, or batch via cron)
create or replace function refresh_entity_score(p_entity uuid) returns void language sql as $$
  update entities set score = hot_score(reaction_counts, created_at), score_updated_at = now()
  where id = p_entity;
$$;

-- ─── fetch_comment_thread: nested comments via recursive CTE ──────────────────
-- Returns a flat ordered set with depth; the server nests into a tree.
create or replace function fetch_comment_thread(
  p_entity uuid, p_root uuid default null, p_limit int default 50, p_offset int default 0
) returns table (
  id uuid, parent_id uuid, depth int, content text, user_id uuid,
  reaction_counts jsonb, replies_count int, created_at timestamptz
) language sql stable as $$
  with recursive thread as (
    select c.id, c.parent_id, 0 as depth, c.content, c.user_id,
           c.reaction_counts, c.replies_count, c.created_at
    from comments c
    where c.entity_id = p_entity
      and c.deleted_at is null
      and c.parent_id is not distinct from p_root
    union all
    select c.id, c.parent_id, t.depth + 1, c.content, c.user_id,
           c.reaction_counts, c.replies_count, c.created_at
    from comments c join thread t on c.parent_id = t.id
    where c.deleted_at is null
  )
  select * from thread order by depth, created_at
  limit p_limit offset p_offset;
$$;

-- ─── match_entities: pgvector semantic search (/search/content) ──────────────
create or replace function match_entities(
  p_project uuid, p_embedding vector(1536), p_limit int default 20, p_space uuid default null
) returns table (entity_id uuid, similarity double precision)
language sql stable as $$
  select e.entity_id, 1 - (e.embedding <=> p_embedding) as similarity
  from entity_embeddings e
  join entities ent on ent.id = e.entity_id
  where e.project_id = p_project
    and ent.deleted_at is null
    and (p_space is null or ent.space_id = p_space)
  order by e.embedding <=> p_embedding
  limit p_limit;
$$;
