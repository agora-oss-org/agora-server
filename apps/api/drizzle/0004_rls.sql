-- Row Level Security (defense-in-depth). The server connects via DATABASE_URL with a
-- role that BYPASSES RLS, so these only bite if a table is reached with an anon/authed
-- key (leaked key, future PostgREST/hybrid path). Enabling RLS with no permissive policy
-- = deny-all to non-privileged callers, the safe default. Idempotent (enable is a no-op
-- if already on).
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
