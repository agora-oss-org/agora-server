// Supabase client — reserved for Auth + Storage only (Drizzle owns DB access, Realtime is
// socket.io). Lazily constructed so the DB-backed server boots even when these keys are
// unset; calling getSupabase() without them throws a clear error.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

let adminClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

const NO_SESSION = { auth: { autoRefreshToken: false, persistSession: false } } as const;

/** Service-role client — admin ops (createUser, generateLink, updateUserById, deleteUser). */
export function getSupabase(): SupabaseClient {
  if (adminClient) return adminClient;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase Auth/Storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  adminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, NO_SESSION);
  return adminClient;
}

/** Anon client — user-facing auth (signUp sends confirmation email, signInWithPassword, resetPasswordForEmail, verifyOtp, resend). */
export function getSupabaseAnon(): SupabaseClient {
  if (anonClient) return anonClient;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error("Supabase auth requires SUPABASE_URL and SUPABASE_ANON_KEY.");
  }
  anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, NO_SESSION);
  return anonClient;
}
