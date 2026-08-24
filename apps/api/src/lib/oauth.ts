// Supabase-brokered OAuth (code + PKCE) helper. Supabase holds the provider secrets and runs the
// provider handshake; Agora orchestrates and mints its own tokens on the callback.
//
// PKCE needs the code_verifier produced during /oauth/authorize to be available at /oauth/callback.
// supabase-js writes that verifier through its storage adapter, so we back the client with an
// in-memory Map, dump it after building the authorize URL, persist it (oauth_states), then reseed a
// fresh client's storage from it on callback before exchangeCodeForSession().
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

function memStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    map,
    adapter: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  };
}

/**
 * Build an anon Supabase client in PKCE mode backed by a capturable in-memory store.
 * Pass `seed` (a prior dump) on the callback side to restore the verifier before exchange.
 * Returns the client plus `dump()` to read whatever the SDK wrote into storage.
 */
export function pkceClient(seed?: Record<string, string>): { client: SupabaseClient; dump: () => Record<string, string> } {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error("Supabase OAuth requires SUPABASE_URL and SUPABASE_ANON_KEY.");
  }
  const store = memStorage(seed);
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      // persistSession MUST be true: gotrue-js ignores a custom `storage` when it's false (it
      // forces an internal memory adapter), and we need the PKCE code_verifier written into OUR
      // Map so we can persist it across the authorize→callback boundary.
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: store.adapter,
    },
  });
  return { client, dump: () => Object.fromEntries(store.map) };
}

export function oauthConfigured(): boolean {
  return !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
}

/**
 * Swap the SUPABASE_URL origin in a browser-facing authorize URL for a public one.
 * Self-hosted GoTrue deployments point SUPABASE_URL at an internal-only shim (proxy:9998), but
 * signInWithOAuth bakes that base into the URL the BROWSER must follow — so when
 * SUPABASE_PUBLIC_AUTH_URL is set, the internal prefix is replaced with it before returning the
 * URL to the client. Unset (cloud Supabase, where SUPABASE_URL is already public) → no rewrite.
 */
export function rewritePublicAuthUrl(url: string, internalBase: string | undefined, publicBase: string | undefined): string {
  if (!internalBase || !publicBase) return url;
  const trim = (s: string) => s.replace(/\/+$/, "");
  const int = trim(internalBase);
  return url.startsWith(int) ? trim(publicBase) + url.slice(int.length) : url;
}

/**
 * The origins an OAuth `redirectAfterAuth` may target. The /oauth/callback handler redirects the
 * browser there **with freshly minted Agora tokens in the URL fragment**, so an unvalidated value is
 * an open redirect that hands an attacker a session — hence a server-side allowlist, mirroring
 * native auth's AUTH_EMAIL_LINK_ALLOWED_ORIGINS.
 *
 * `list` is the comma-separated OAUTH_REDIRECT_ALLOWED_ORIGINS. When unset we fall back to
 * PUBLIC_BASE_URL, so an ordinary single-origin deployment needs no extra config. Neither set →
 * empty, and the caller fails CLOSED (503) rather than trusting client input.
 */
export function resolveRedirectAllowlist(list: string | undefined, publicBaseUrl: string | undefined): string[] {
  const explicit = (list ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (explicit.length > 0) return explicit;
  const fallback = (publicBaseUrl ?? "").trim();
  return fallback ? [fallback] : [];
}

/**
 * Is `target` allowed by `allowed`? http(s) entries match by ORIGIN (any path/query is fine, but a
 * different host, port or scheme is not — so `http://localhost.evil.example` can't pass as
 * `http://localhost`). Non-http entries are mobile deep-link scheme prefixes (`myapp://`) and match
 * literally. Malformed / protocol-relative / non-web targets are always rejected.
 */
export function isAllowedRedirect(target: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  let targetOrigin: string | null = null;
  try {
    const u = new URL(target);
    if (u.protocol === "http:" || u.protocol === "https:") targetOrigin = u.origin;
  } catch {
    return false; // relative ("//evil"), malformed — never a valid post-auth destination
  }
  for (const entry of allowed) {
    if (targetOrigin !== null) {
      try {
        const e = new URL(entry);
        if ((e.protocol === "http:" || e.protocol === "https:") && e.origin === targetOrigin) return true;
      } catch {
        /* not a URL — fall through to the deep-link prefix check below */
      }
    }
    // Deep-link entries (`myapp://`) only ever match a literal prefix, never an http(s) target.
    if (targetOrigin === null && !/^https?:\/\//i.test(entry) && target.startsWith(entry)) return true;
  }
  return false;
}
