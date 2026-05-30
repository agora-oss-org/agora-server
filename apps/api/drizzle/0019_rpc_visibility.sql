-- Push read-visibility filtering INTO the set-returning RPCs (was JS post-filtering):
--   * space_readable(space, viewer)  — reusable predicate: public space, no space, owner, or active member
--   * fetch_comment_thread(..., p_hide_removed) — prunes moderation-removed comments AND their subtrees
--   * match_content(..., p_viewer, p_privileged, p_hide_removed) — applies space/membership/removed
--     visibility so LIMIT counts only rows the caller may actually see (no more short pages).
-- Idempotent: drop the old signatures before recreating (arg lists changed).

-- ── reusable space-read predicate (also the basis for RLS hardening) ─────────────────────────────
create or replace function space_readable(p_space uuid, p_viewer uuid) returns boolean
language sql stable as $$
  select p_space is null or exists (
    select 1 from spaces s
    where s.id = p_space and s.deleted_at is null
      and (s.reading_permission = 'anyone'
        or (p_viewer is not null and (
          s.user_id = p_viewer
          or exists (select 1 from space_members sm
                     where sm.space_id = s.id and sm.user_id = p_viewer and sm.status = 'active'))))
  );
$$;

-- ── threaded comments: optionally prune removed comments (and their descendants) ─────────────────
drop function if exists fetch_comment_thread(uuid, uuid, int, int);
create or replace function fetch_comment_thread(
  p_entity uuid, p_root uuid default null, p_limit int default 50, p_offset int default 0,
  p_hide_removed boolean default false
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
      and (not p_hide_removed or c.moderation_status is distinct from 'removed')
    union all
    select c.id, c.parent_id, t.depth + 1, c.content, c.user_id,
           c.reaction_counts, c.replies_count, c.created_at
    from comments c join thread t on c.parent_id = t.id
    where c.deleted_at is null
      and (not p_hide_removed or c.moderation_status is distinct from 'removed')
  )
  select * from thread order by depth, created_at
  limit p_limit offset p_offset;
$$;

-- ── semantic search: filter by caller visibility inside the RPC ──────────────────────────────────
-- p_privileged (operator) bypasses space/membership/removed gating; p_hide_removed drops removed
-- content (hide mode). Entities/comments use space_readable(); messages require active membership.
drop function if exists match_content(uuid, vector, int, text[], uuid);
create or replace function match_content(
  p_project uuid, p_embedding vector(1024), p_limit int default 20,
  p_source_types text[] default null, p_space uuid default null,
  p_viewer uuid default null, p_privileged boolean default false, p_hide_removed boolean default false
) returns table (source_type text, source_id uuid, similarity double precision)
language sql stable as $$
  select ce.source_type, ce.source_id, 1 - (ce.embedding <=> p_embedding) as similarity
  from content_embeddings ce
  where ce.project_id = p_project
    and (p_source_types is null or ce.source_type = any(p_source_types))
    and case ce.source_type
      when 'entity' then exists (
        select 1 from entities e where e.id = ce.source_id and e.deleted_at is null
          and (p_space is null or e.space_id = p_space)
          and (not p_hide_removed or e.moderation_status is distinct from 'removed')
          and (p_privileged or space_readable(e.space_id, p_viewer)))
      when 'comment' then exists (
        select 1 from comments c join entities e on e.id = c.entity_id
          where c.id = ce.source_id and c.deleted_at is null
          and (p_space is null or e.space_id = p_space)
          and (not p_hide_removed or c.moderation_status is distinct from 'removed')
          and (p_privileged or space_readable(e.space_id, p_viewer)))
      when 'message' then p_space is null and exists (
        select 1 from chat_messages m where m.id = ce.source_id and m.user_deleted_at is null
          and (not p_hide_removed or m.moderation_status is distinct from 'removed')
          and (p_privileged or exists (
            select 1 from conversation_members cm
            where cm.conversation_id = m.conversation_id and cm.user_id = p_viewer and cm.is_active)))
      else true
    end
  order by ce.embedding <=> p_embedding
  limit p_limit;
$$;
