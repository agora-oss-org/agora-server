-- Agora 0008 — Row Level Security (defense-in-depth)
-- The API server uses the SERVICE-ROLE key, which BYPASSES RLS. These policies only
-- bite if a table is ever reached with an anon/authed key (e.g. direct PostgREST,
-- a leaked key, or a future hybrid pattern). Enabling RLS with no permissive policy
-- = deny-all to non-service callers, which is the safe default.

do $$ declare t text;
begin
  foreach t in array array[
    'projects','project_integrations','profiles','user_suspensions','oauth_identities',
    'entities','comments','reactions','spaces','space_members','space_rules',
    'follows','connections','conversations','conversation_members','chat_messages',
    'chat_message_reactions','collections','collection_entities','files',
    'app_notifications','reports','entity_embeddings']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Example public-read policy for entities (uncomment + adapt if you expose PostgREST
-- directly for read paths). Left commented because Pattern 2 (service-role server) is
-- the chosen architecture.
--
-- create policy entities_public_read on entities
--   for select using (deleted_at is null and moderation_status is distinct from 'removed');
--
-- create policy profiles_self_write on profiles
--   for update using (auth_user_id = auth.uid());
