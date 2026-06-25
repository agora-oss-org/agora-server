import { describe, it, expect } from "vitest";
import { buildRunningConfig } from "./running-config.js";
import type { Env } from "./env.js";

const SECRET = "s3cr3t-do-not-leak-9f8a7b6c";

// A fully-populated Env with every secret set to the same sentinel, so one assertion proves no
// secret value reaches the output.
const fullEnv = {
  PORT: 4000,
  DATABASE_URL: `postgres://dbuser:${SECRET}@db.example.com:6543/postgres`,
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: SECRET,
  SUPABASE_ANON_KEY: SECRET,
  ACCESS_TOKEN_TTL: 1800,
  REFRESH_TOKEN_TTL: 2592000,
  ACCESS_TOKEN_SECRET: SECRET,
  REFRESH_TOKEN_GRACE_SECONDS: 30,
  CORS_ORIGIN: "*",
  OPERATOR_USER_IDS: "11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222",
  OPERATOR_EMAILS: "ops@example.com",
  PUBLIC_BASE_URL: "https://api.example.com",
  CRON_SECRET: SECRET,
  MODERATION_SERVICE_SECRET: SECRET,
  RATE_LIMIT_WINDOW_SECONDS: 60,
  RATE_LIMIT_MAX: 120,
  RATE_LIMIT_AUTH_MAX: 20,
  VOYAGE_API_KEY: SECRET,
  VOYAGE_MODEL: "voyage-3.5",
  EMBEDDING_DIMENSIONS: 1024,
  ANTHROPIC_API_KEY: SECRET,
  ANTHROPIC_MODEL: "claude-sonnet-4-6",
  ANTHROPIC_MAX_TOKENS: 1024,
} as unknown as Env;

// Optional features all unset (empty-string-as-unset already normalized to undefined by env.ts).
const minimalEnv = {
  PORT: 4000,
  DATABASE_URL: "postgres://u:p@localhost:5432/agora",
  ACCESS_TOKEN_TTL: 1800,
  REFRESH_TOKEN_TTL: 2592000,
  ACCESS_TOKEN_SECRET: "x",
  REFRESH_TOKEN_GRACE_SECONDS: 30,
  CORS_ORIGIN: "*",
  RATE_LIMIT_WINDOW_SECONDS: 60,
  VOYAGE_MODEL: "voyage-3.5",
  EMBEDDING_DIMENSIONS: 1024,
  ANTHROPIC_MODEL: "claude-sonnet-4-6",
  ANTHROPIC_MAX_TOKENS: 1024,
} as unknown as Env;

describe("buildRunningConfig", () => {
  it("never emits a secret value", () => {
    const json = JSON.stringify(buildRunningConfig(fullEnv));
    expect(json).not.toContain(SECRET); // covers all keys + the DB password
  });

  it("reduces DATABASE_URL to host + db name, stripping credentials", () => {
    const cfg = buildRunningConfig(fullEnv);
    expect(cfg.database).toEqual({ host: "db.example.com:6543", database: "postgres" });
  });

  it("reports enablement booleans + non-sensitive values", () => {
    const cfg = buildRunningConfig(fullEnv);
    expect(cfg.auth.supabase.serviceRoleKeySet).toBe(true);
    expect(cfg.auth.supabase.url).toBe("https://abc.supabase.co"); // public URL echoed
    expect(cfg.auth.accessTokenTtlSeconds).toBe(1800);
    expect(cfg.operators).toEqual({ userIdCount: 2, emailCount: 1, configured: true });
    expect(cfg.rateLimit).toEqual({ windowSeconds: 60, max: 120, authMax: 20, enabled: true });
    expect(cfg.embeddings.enabled).toBe(true);
    expect(cfg.llm.enabled).toBe(true);
    expect(cfg.internal).toEqual({ cronEnabled: true, moderationWriteBackEnabled: true });
  });

  it("marks optional features disabled when their keys are unset", () => {
    const cfg = buildRunningConfig(minimalEnv);
    expect(cfg.embeddings.enabled).toBe(false);
    expect(cfg.llm.enabled).toBe(false);
    expect(cfg.rateLimit.enabled).toBe(false);
    expect(cfg.auth.supabase.configured).toBe(false);
    expect(cfg.operators.configured).toBe(false);
    expect(cfg.internal).toEqual({ cronEnabled: false, moderationWriteBackEnabled: false });
    expect(cfg.publicBaseUrl).toBeNull();
  });
});
