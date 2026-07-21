-- Events become searchable (semantic /search/content, 4th source type "event").
--
-- The hard part is visibility. Events are tiered (public|members|invite) ON TOP of the space-read
-- gate, so the search gate must reproduce the events LIST predicate exactly — search is an
-- enumeration surface, and an enumeration surface that is more permissive than the list is a leak.
-- That predicate therefore exists TWICE, on purpose: here as can_view_event(), and inline in the
-- events-list query (routes/events.ts). Sharing one function across both was tried and reverted —
-- calling can_view_event() from the list collapsed its plan to an opaque per-row
-- `Filter: can_view_event(...)`, losing the `hashed SubPlan` treatment the planner gives the
-- space_members lookups when the predicate is written inline (computed once, reused across rows).
-- match_content can afford the per-row call (its candidate set is tiny and vector-limited); a full
-- events-list scan cannot. Any change here MUST be mirrored in routes/events.ts and vice versa;
-- test/integration/event-search-visibility.test.ts asserts search ⊆ list for every caller, which is
-- what actually catches drift between the two.
--
-- Idempotent: create or replace throughout.
SET search_path TO public, extensions;
--> statement-breakpoint

-- ── can_view_event: the shared event visibility gate ──────────────────────────────────────────────
-- Ported verbatim from the events-list predicate (routes/events.ts). Semantics, in order:
--   • the row must be live (deleted_at is null)
--   • p_hide_removed drops moderation-removed events (the removedPolicy(c) equivalent)
--   • p_privileged (operator / project-admin) bypasses the rest — they manage all content
--   • otherwise: space_readable() AND the per-row visibility tier
-- The space gate is AND'd across the WHOLE visibility predicate, not just the public branch — an
-- invitee or host who cannot read the event's space must NOT see it (otherwise the list/search would
-- be more permissive than single-GET, which 403s). Fail closed.
-- LANGUAGE SQL STABLE (not plpgsql) so the planner can inline it into the list's WHERE clause.
CREATE OR REPLACE FUNCTION can_view_event(
  p_event uuid, p_viewer uuid, p_privileged boolean default false, p_hide_removed boolean default false
) returns boolean
language sql stable as $$
  select exists (
    select 1 from events e
    where e.id = p_event
      and e.deleted_at is null
      and (not p_hide_removed or e.moderation_status is distinct from 'removed')
      and (p_privileged or (
        space_readable(e.space_id, p_viewer)
        and (
          e.visibility = 'public'
          -- Anonymous (p_viewer null) never reaches past 'public' — every branch below needs an
          -- identity to match against. This is what makes the gate fail closed for logged-out callers.
          or (p_viewer is not null and (
            (e.visibility = 'members' and (
              e.space_id is null
              or exists (select 1 from space_members m
                         where m.space_id = e.space_id and m.user_id = p_viewer and m.status = 'active')
              or exists (select 1 from spaces s where s.id = e.space_id and s.user_id = p_viewer)))
            or (e.visibility = 'invite' and exists (
                  select 1 from event_invites i where i.event_id = e.id and i.user_id = p_viewer))
            -- Hosts see their own event at any visibility tier (still subject to space_readable above).
            or exists (select 1 from event_hosts h where h.event_id = e.id and h.user_id = p_viewer)
          ))
        )
      ))
  );
$$;
--> statement-breakpoint

-- ── match_content: add the 'event' branch, and make the CASE fail CLOSED ───────────────────────────
-- Signature is unchanged from 0063, so create-or-replace suffices (no drop needed).
--
-- The `else` arm flips true -> false. It previously made any UNKNOWN source_type visible to every
-- caller with no gate at all. That was latent while only entity/comment/message existed, but it is a
-- live hole the moment a deploy ships app code ahead of this migration: the app would begin writing
-- 'event' rows into content_embeddings, and every one of them — including invite-only events — would
-- match for anonymous callers. Failing closed means an ungated type is simply invisible until its
-- branch exists, which is the correct default for a security gate.
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
      -- Events honour space scoping like entities (an event may carry a space_id); the whole
      -- visibility decision delegates to the shared gate.
      when 'event' then exists (
        select 1 from events e where e.id = ce.source_id
          and (p_space is null or e.space_id = p_space)
          and (p_space_ids is null or e.space_id = any(p_space_ids))
          and can_view_event(ce.source_id, p_viewer, p_privileged, p_hide_removed))
      else false
    end
  order by ce.embedding <=> p_embedding
  limit p_limit;
$$;
