// OAuth sign-in helpers for the admin login screen — the pure half (parsing), kept out of the React
// components so it can be unit-tested without a DOM.
//
// The server flow (MANIFEST §oauth): POST /oauth/authorize { provider, redirectAfterAuth } →
// { authorizationUrl } → provider consent → GoTrue /auth/v1/callback → API /oauth/callback →
// browser lands back on `redirectAfterAuth` with EITHER
//   #accessToken=…&refreshToken=…            (success)
//   ?error=<code>&error_description=<text>   (failure)

/** Providers the admin can render a button for. Anything else in config is ignored. */
export const PROVIDER_LABELS = {
  google: "Google",
  github: "GitHub",
  apple: "Apple",
} as const;

export type OAuthProvider = keyof typeof PROVIDER_LABELS;

export interface OAuthCallbackTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Parse the configured provider list (`AGORA_ADMIN_OAUTH_PROVIDERS=google,github,apple`).
 * Unknown names are dropped rather than rendered as an unlabelled button; order is preserved.
 */
export function parseProviders(raw: string | undefined): OAuthProvider[] {
  const seen = new Set<OAuthProvider>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if (name in PROVIDER_LABELS) seen.add(name as OAuthProvider);
  }
  return [...seen];
}

/**
 * Read the tokens the API put in the URL fragment. Returns null unless BOTH are present and
 * non-empty — a half-populated fragment is treated as "not a callback", never as a partial session.
 */
export function parseCallbackHash(hash: string): OAuthCallbackTokens | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const accessToken = params.get("accessToken");
  const refreshToken = params.get("refreshToken");
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

/** Human-readable message from a failed provider hop (`?error=&error_description=`), or null. */
export function parseCallbackError(search: string): string | null {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  const code = params.get("error");
  if (!code) return null;
  return params.get("error_description") || code;
}
