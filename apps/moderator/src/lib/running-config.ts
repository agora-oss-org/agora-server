// Builds the redacted "running configuration" snapshot for GET /v1/:projectId/moderation/config
// (operator-only). Mirrors the API's lib/running-config.ts: NEVER emit a secret value — secret-
// bearing settings report as `*Set`/`*Enabled` booleans; only non-sensitive values are echoed, and
// DATABASE_URL is reduced to host + db name with credentials stripped. The LLM block here is the
// service's ENV DEFAULTS — a project can override any of them (admin Settings → Moderator), resolved
// per assessment in lib/project-config.ts. Pure → unit-tested to assert no secret leaks.
import type { Env } from "./env.js";

const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

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
    port: e.MODERATOR_PORT,
    corsOrigin: e.CORS_ORIGIN,
    database: dbEndpoint(e.DATABASE_URL), // host + db name only — credentials stripped
    accessTokenSecretSet: isSet(e.ACCESS_TOKEN_SECRET), // verifies the admin/operator JWT
    // Write-back to the API (the moderator's only mutation path; the API stays the trust boundary).
    writeBack: {
      apiBaseUrl: e.API_BASE_URL ?? null,
      serviceSecretSet: isSet(e.MODERATION_SERVICE_SECRET),
      enabled: isSet(e.API_BASE_URL) && isSet(e.MODERATION_SERVICE_SECRET), // mirrors writeBackEnabled()
    },
    // Service-level DEFAULTS — overridable per project (projects.moderator_config).
    defaults: {
      autoActionThreshold: e.MODERATION_AUTO_ACTION_THRESHOLD,
      llm: {
        provider: e.MODERATOR_LLM_PROVIDER,
        baseUrl: e.MODERATOR_LLM_BASE_URL ?? null, // null → the provider's default host
        model: e.MODERATOR_LLM_MODEL,
        maxTokens: e.MODERATOR_LLM_MAX_TOKENS,
        apiKeySet: isSet(e.MODERATOR_LLM_API_KEY),
        enabled: isSet(e.MODERATOR_LLM_API_KEY), // without a key the moderator can't assess
      },
    },
  };
}

export type RunningConfig = ReturnType<typeof buildRunningConfig>;
