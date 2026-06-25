// Builds the redacted "running configuration" snapshot for GET /admin/config (operator-only).
// The rule: NEVER emit a secret value. Secret-bearing settings are reported as booleans
// (`*Set` / `*Enabled`); only non-sensitive values (ports, TTLs, model names, public URLs, feature
// toggles) are echoed. DATABASE_URL is reduced to host + db name with credentials stripped. Pure —
// takes the validated Env and returns plain data, so it's unit-tested to assert no secret leaks.
import type { Env } from "./env.js";

const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

const csvCount = (v?: string): number => (v ? v.split(",").map((s) => s.trim()).filter(Boolean).length : 0);

// Reduce a postgres connection string to { host, database } — drop the user:password credentials.
function dbEndpoint(url: string): { host: string; database: string | null } | null {
  try {
    const u = new URL(url);
    return { host: u.port ? `${u.hostname}:${u.port}` : u.hostname, database: u.pathname.replace(/^\//, "") || null };
  } catch {
    return null;
  }
}

export function buildRunningConfig(e: Env) {
  return {
    port: e.PORT,
    corsOrigin: e.CORS_ORIGIN,
    publicBaseUrl: e.PUBLIC_BASE_URL ?? null,
    database: dbEndpoint(e.DATABASE_URL), // host + db name only — credentials stripped
    auth: {
      accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL,
      refreshTokenTtlSeconds: e.REFRESH_TOKEN_TTL,
      refreshTokenGraceSeconds: e.REFRESH_TOKEN_GRACE_SECONDS,
      accessTokenSecretSet: isSet(e.ACCESS_TOKEN_SECRET),
      supabase: {
        url: e.SUPABASE_URL ?? null, // the public project URL (not a secret)
        serviceRoleKeySet: isSet(e.SUPABASE_SERVICE_ROLE_KEY),
        anonKeySet: isSet(e.SUPABASE_ANON_KEY),
        // Supabase Auth + Storage need a URL + service-role key to be usable.
        configured: isSet(e.SUPABASE_URL) && isSet(e.SUPABASE_SERVICE_ROLE_KEY),
      },
    },
    operators: {
      // Report counts, not the actual UUIDs/emails on the allowlist.
      userIdCount: csvCount(e.OPERATOR_USER_IDS),
      emailCount: csvCount(e.OPERATOR_EMAILS),
      configured: isSet(e.OPERATOR_USER_IDS) || isSet(e.OPERATOR_EMAILS),
    },
    rateLimit: {
      windowSeconds: e.RATE_LIMIT_WINDOW_SECONDS,
      max: e.RATE_LIMIT_MAX ?? null,
      authMax: e.RATE_LIMIT_AUTH_MAX ?? null,
      enabled: isSet(e.RATE_LIMIT_MAX), // off unless a general cap is set
    },
    embeddings: {
      provider: "voyage",
      model: e.VOYAGE_MODEL,
      dimensions: e.EMBEDDING_DIMENSIONS,
      apiKeySet: isSet(e.VOYAGE_API_KEY),
      enabled: isSet(e.VOYAGE_API_KEY), // semantic search needs the key
    },
    llm: {
      provider: "anthropic",
      model: e.ANTHROPIC_MODEL,
      maxTokens: e.ANTHROPIC_MAX_TOKENS,
      apiKeySet: isSet(e.ANTHROPIC_API_KEY),
      enabled: isSet(e.ANTHROPIC_API_KEY), // /search/ask RAG needs the key
    },
    internal: {
      cronEnabled: isSet(e.CRON_SECRET), // /internal/cron/* gated by CRON_SECRET
      moderationWriteBackEnabled: isSet(e.MODERATION_SERVICE_SECRET), // /internal/moderation/apply
    },
  };
}

export type RunningConfig = ReturnType<typeof buildRunningConfig>;
