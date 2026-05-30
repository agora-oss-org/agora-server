-- RLS: enablement backstop + authenticated self-access reads.
--
-- Trust model: the Agora server connects as an RLS-BYPASSING role, so RLS is pure defense-in-depth
-- for the path where a table is reached with a Supabase anon/authenticated key (leaked key, or a
-- future direct-PostgREST read path). Writes have NO policy anywhere → denied to non-privileged
-- roles (server-only). Idempotent: enable is a no-op if already on; policies drop-if-exists first.

-- ── Part 1 — enablement backstop ────────────────────────────────────────────────────────────────
-- Ensure EVERY public base table has RLS on, so any table added by a future migration is deny-all
-- by default rather than silently world-readable. spatial_ref_sys is PostGIS-owned reference data
-- (not app data, and not alterable by us) → skip it.
do $$ declare t text;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'spatial_ref_sys'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
--> statement-breakpoint

-- ── Part 2 — authenticated self-access reads ────────────────────────────────────────────────────
-- A signed-in user may read ONLY their own private rows. Identity maps Supabase auth.uid() → Agora
-- profiles through SECURITY DEFINER helpers in a NON-EXPOSED `private` schema. The helpers bypass
-- RLS on purpose: (a) profiles is never exposed (row-level RLS can't mask email/secure_metadata),
-- and (b) referencing conversation_members from its own policy would be infinite recursion.
-- Helpers only ever return the caller's own ids, so SECURITY DEFINER leaks nothing.
create schema if not exists private;
--> statement-breakpoint
revoke all on schema private from public;
--> statement-breakpoint
grant usage on schema private to authenticated;
--> statement-breakpoint

create or replace function private.current_profile_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select id from public.profiles where auth_user_id = (select auth.uid())
$$;
--> statement-breakpoint
revoke all on function private.current_profile_ids() from public;
--> statement-breakpoint
grant execute on function private.current_profile_ids() to authenticated;
--> statement-breakpoint

create or replace function private.current_conversation_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select cm.conversation_id from public.conversation_members cm
  where cm.is_active and cm.user_id in (
    select id from public.profiles where auth_user_id = (select auth.uid()))
$$;
--> statement-breakpoint
revoke all on function private.current_conversation_ids() from public;
--> statement-breakpoint
grant execute on function private.current_conversation_ids() to authenticated;
--> statement-breakpoint

-- app_notifications — your inbox.
grant select on "app_notifications" to authenticated;
--> statement-breakpoint
drop policy if exists "app_notifications_self_read" on "app_notifications";
--> statement-breakpoint
create policy "app_notifications_self_read" on "app_notifications" for select to authenticated
  using (user_id in (select private.current_profile_ids()));
--> statement-breakpoint

-- collections — your saved-content folders.
grant select on "collections" to authenticated;
--> statement-breakpoint
drop policy if exists "collections_self_read" on "collections";
--> statement-breakpoint
create policy "collections_self_read" on "collections" for select to authenticated
  using (user_id in (select private.current_profile_ids()));
--> statement-breakpoint

-- collection_entities — rows inside your own collections.
grant select on "collection_entities" to authenticated;
--> statement-breakpoint
drop policy if exists "collection_entities_self_read" on "collection_entities";
--> statement-breakpoint
create policy "collection_entities_self_read" on "collection_entities" for select to authenticated
  using (collection_id in (
    select id from collections where user_id in (select private.current_profile_ids())));
--> statement-breakpoint

-- connections — friend requests you sent or received.
grant select on "connections" to authenticated;
--> statement-breakpoint
drop policy if exists "connections_self_read" on "connections";
--> statement-breakpoint
create policy "connections_self_read" on "connections" for select to authenticated
  using (requester_id in (select private.current_profile_ids())
      or addressee_id in (select private.current_profile_ids()));
--> statement-breakpoint

-- oauth_identities — your linked providers.
grant select on "oauth_identities" to authenticated;
--> statement-breakpoint
drop policy if exists "oauth_identities_self_read" on "oauth_identities";
--> statement-breakpoint
create policy "oauth_identities_self_read" on "oauth_identities" for select to authenticated
  using (profile_id in (select private.current_profile_ids()));
--> statement-breakpoint

-- reports — reports you filed (moderators read via the server, which bypasses RLS).
grant select on "reports" to authenticated;
--> statement-breakpoint
drop policy if exists "reports_self_read" on "reports";
--> statement-breakpoint
create policy "reports_self_read" on "reports" for select to authenticated
  using (reporter_id in (select private.current_profile_ids()));
--> statement-breakpoint

-- files — your own uploads.
grant select on "files" to authenticated;
--> statement-breakpoint
drop policy if exists "files_self_read" on "files";
--> statement-breakpoint
create policy "files_self_read" on "files" for select to authenticated
  using (user_id in (select private.current_profile_ids()));
--> statement-breakpoint

-- space_members — your own memberships.
grant select on "space_members" to authenticated;
--> statement-breakpoint
drop policy if exists "space_members_self_read" on "space_members";
--> statement-breakpoint
create policy "space_members_self_read" on "space_members" for select to authenticated
  using (user_id in (select private.current_profile_ids()));
--> statement-breakpoint

-- conversations — DMs/threads you're an active member of.
grant select on "conversations" to authenticated;
--> statement-breakpoint
drop policy if exists "conversations_member_read" on "conversations";
--> statement-breakpoint
create policy "conversations_member_read" on "conversations" for select to authenticated
  using (id in (select private.current_conversation_ids()));
--> statement-breakpoint

-- conversation_members — the roster of conversations you're in.
grant select on "conversation_members" to authenticated;
--> statement-breakpoint
drop policy if exists "conversation_members_member_read" on "conversation_members";
--> statement-breakpoint
create policy "conversation_members_member_read" on "conversation_members" for select to authenticated
  using (conversation_id in (select private.current_conversation_ids()));
--> statement-breakpoint

-- chat_messages — messages in your conversations.
grant select on "chat_messages" to authenticated;
--> statement-breakpoint
drop policy if exists "chat_messages_member_read" on "chat_messages";
--> statement-breakpoint
create policy "chat_messages_member_read" on "chat_messages" for select to authenticated
  using (conversation_id in (select private.current_conversation_ids()));
--> statement-breakpoint

-- chat_message_reactions — reactions on messages in your conversations.
grant select on "chat_message_reactions" to authenticated;
--> statement-breakpoint
drop policy if exists "chat_message_reactions_member_read" on "chat_message_reactions";
--> statement-breakpoint
create policy "chat_message_reactions_member_read" on "chat_message_reactions" for select to authenticated
  using (message_id in (
    select id from chat_messages where conversation_id in (select private.current_conversation_ids())));
