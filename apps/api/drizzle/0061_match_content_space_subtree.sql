-- Search includeChildSpaces (SDK v7.8.2, PR #38): match_content gains p_space_ids uuid[]. When set,
-- entities/comments match space_id = any(p_space_ids) (a resolved {self ∪ descendants} set) instead of
-- a single p_space; messages remain excluded whenever any space scoping is present. All existing
-- visibility gates (space_readable, membership, removed) are preserved. Idempotent recreate.
SET search_path TO public, extensions;
--> statement-breakpoint
DROP FUNCTION IF EXISTS match_content(uuid, vector, int, text[], uuid, uuid, boolean, boolean);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION match_content(
  p_project uuid, p_embedding vector(1024), p_limit int default 20,
  p_source_types text[] default null, p_space uuid default null,
  p_viewer uuid default null, p_privileged boolean default false, p_hide_removed boolean default false,
  p_space_ids uuid[] default null
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
          and (p_space_ids is null or e.space_id = any(p_space_ids))
          and (not p_hide_removed or e.moderation_status is distinct from 'removed')
          and (p_privileged or space_readable(e.space_id, p_viewer)))
      when 'comment' then exists (
        select 1 from comments c join entities e on e.id = c.entity_id
          where c.id = ce.source_id and c.deleted_at is null
          and (p_space is null or e.space_id = p_space)
          and (p_space_ids is null or e.space_id = any(p_space_ids))
          and (not p_hide_removed or c.moderation_status is distinct from 'removed')
          and (p_privileged or space_readable(e.space_id, p_viewer)))
      when 'message' then p_space is null and p_space_ids is null and exists (
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
