-- Secure chat (E2E/MLS) — RLS backstop + last_message_at trigger. Hand-written + idempotent.
--
-- RLS posture is STRICTER than plaintext chat: enable deny-all on every secure table and grant
-- NO select to `authenticated`. These tables are server-only relays (the server connects as an
-- RLS-bypassing role); there is no client-direct/PostgREST read path, and even ciphertext/key
-- material should never be reachable with a leaked Supabase anon/authenticated key. The one-time
-- enablement loop in 0017 ran before these tables existed, so enable them explicitly here.
do $$ declare t text;
begin
  foreach t in array array[
    'secure_devices','secure_key_packages','secure_conversations','secure_conversation_members',
    'secure_messages','secure_handshake_messages','secure_key_backups'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
--> statement-breakpoint

-- Bump the conversation's last_message_at when a ciphertext message lands (mirrors the plaintext
-- on_chat_message_insert trigger in 0002; the server never reads the message, only its arrival).
create or replace function on_secure_message_insert() returns trigger language plpgsql as $$
begin
  update secure_conversations set last_message_at = new.created_at where id = new.conversation_id;
  return null;
end $$;
--> statement-breakpoint
drop trigger if exists trg_secure_message_insert on secure_messages;
--> statement-breakpoint
create trigger trg_secure_message_insert after insert on secure_messages
  for each row execute function on_secure_message_insert();
