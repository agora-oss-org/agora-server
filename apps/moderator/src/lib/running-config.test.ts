import { describe, it, expect } from "vitest";
import { buildRunningConfig } from "./running-config.js";
import type { Env } from "./env.js";

const SECRET = "s3cr3t-do-not-leak-9f8a7b6c";

// Every secret set to one sentinel, so a single assertion proves no secret value reaches the output.
const fullEnv = {
  MODERATOR_PORT: 4001,
  DATABASE_URL: `postgres://dbuser:${SECRET}@db.example.com:6543/postgres`,
  ACCESS_TOKEN_SECRET: SECRET,
  CORS_ORIGIN: "*",
  API_BASE_URL: "http://localhost:4000",
  MODERATION_SERVICE_SECRET: SECRET,
  MODERATION_AUTO_ACTION_THRESHOLD: 0.85,
  MODERATOR_LLM_PROVIDER: "anthropic",
  MODERATOR_LLM_BASE_URL: "https://api.anthropic.com",
  MODERATOR_LLM_API_KEY: SECRET,
  MODERATOR_LLM_MODEL: "claude-haiku-4-5-20251001",
  MODERATOR_LLM_MAX_TOKENS: 512,
} as unknown as Env;

// LLM + write-back unconfigured.
const minimalEnv = {
  MODERATOR_PORT: 4001,
  DATABASE_URL: "postgres://u:p@localhost:5432/agora",
  ACCESS_TOKEN_SECRET: "x",
  CORS_ORIGIN: "*",
  MODERATION_AUTO_ACTION_THRESHOLD: 0.85,
  MODERATOR_LLM_PROVIDER: "openai",
  MODERATOR_LLM_MODEL: "gpt-4o-mini",
  MODERATOR_LLM_MAX_TOKENS: 512,
} as unknown as Env;

describe("buildRunningConfig (moderator)", () => {
  it("never emits a secret value", () => {
    const json = JSON.stringify(buildRunningConfig(fullEnv));
    expect(json).not.toContain(SECRET); // covers the LLM key, service secret, JWT secret + DB password
  });

  it("reduces DATABASE_URL to host + db name, stripping credentials", () => {
    expect(buildRunningConfig(fullEnv).database).toEqual({ host: "db.example.com:6543", database: "postgres" });
  });

  it("reports enablement booleans + non-sensitive defaults", () => {
    const cfg = buildRunningConfig(fullEnv);
    expect(cfg.accessTokenSecretSet).toBe(true);
    expect(cfg.writeBack).toEqual({ apiBaseUrl: "http://localhost:4000", serviceSecretSet: true, enabled: true });
    expect(cfg.defaults.autoActionThreshold).toBe(0.85);
    expect(cfg.defaults.llm.provider).toBe("anthropic");
    expect(cfg.defaults.llm.model).toBe("claude-haiku-4-5-20251001");
    expect(cfg.defaults.llm.apiKeySet).toBe(true);
    expect(cfg.defaults.llm.enabled).toBe(true);
  });

  it("marks write-back + LLM disabled when their keys are unset", () => {
    const cfg = buildRunningConfig(minimalEnv);
    expect(cfg.writeBack).toEqual({ apiBaseUrl: null, serviceSecretSet: false, enabled: false });
    expect(cfg.defaults.llm.apiKeySet).toBe(false);
    expect(cfg.defaults.llm.enabled).toBe(false);
    expect(cfg.defaults.llm.baseUrl).toBeNull();
  });
});
