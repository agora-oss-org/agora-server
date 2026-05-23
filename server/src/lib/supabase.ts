// Supabase client — reserved for Auth + Storage only (Drizzle owns DB access, Realtime is
// socket.io). Lazily constructed so the DB-backed server boots even when these keys are
// unset; calling getSupabase() without them throws a clear error.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase Auth/Storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment."
    );
  }
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}
