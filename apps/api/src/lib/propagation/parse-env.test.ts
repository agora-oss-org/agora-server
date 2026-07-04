import { describe, expect, it } from "vitest";
import { extractComposeKeys, extractEnvExampleKeys, extractEnvSchemaKeys, mentions } from "./parse-env";

const ENV_TS = `
import { z } from "zod";
const schema = z.object({
  PORT: z.coerce.number().default(4000),
  // Supabase transaction pooler — Drizzle owns DB access.
  DATABASE_URL: z.string().url(),
  CONTENT_DELETE_MODE: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["soft", "hard"]).default("soft")),
});
export const env = schema.parse(process.env);
`;

const EXAMPLE = `
# ── Bring it up — local Postgres (the default) ────────────────────────────────
AGORA_ENV=dev
ACCESS_TOKEN_SECRET=<GENERATE: openssl rand -base64 48>
# CLOUD switch — uncomment to use Supabase instead:
# SUPABASE_URL=https://xyz.supabase.co
#   RATE_LIMIT_MAX=300
`;

const COMPOSE = `
services:
  agora:
    image: agora
    environment:
      CONTENT_DELETE_MODE: \${CONTENT_DELETE_MODE:-soft}
      OTEL_SDK_DISABLED: \${OTEL_SDK_DISABLED:-true}
    ports:
      - "\${DB_PORT:-5432}:5432"
`;

describe("extractEnvSchemaKeys", () => {
  it("extracts top-level z.object keys, skipping comments and nested lines", () => {
    expect(extractEnvSchemaKeys(ENV_TS)).toEqual(["PORT", "DATABASE_URL", "CONTENT_DELETE_MODE"]);
  });
});

describe("extractEnvExampleKeys", () => {
  it("counts active and commented-switch assignments, not prose comments", () => {
    const keys = extractEnvExampleKeys(EXAMPLE);
    expect(keys).toEqual(new Set(["AGORA_ENV", "ACCESS_TOKEN_SECRET", "SUPABASE_URL", "RATE_LIMIT_MAX"]));
  });
});

describe("extractComposeKeys", () => {
  it("counts environment keys and ${VAR} interpolations, not yaml config keys", () => {
    const keys = extractComposeKeys(COMPOSE);
    expect(keys.has("CONTENT_DELETE_MODE")).toBe(true);
    expect(keys.has("OTEL_SDK_DISABLED")).toBe(true);
    expect(keys.has("DB_PORT")).toBe(true); // interpolation-only ref still counts
    expect(keys.has("image")).toBe(false);
  });
});

describe("mentions", () => {
  it("matches whole tokens only", () => {
    expect(mentions("set CONTENT_DELETE_MODE=hard to enable", "CONTENT_DELETE_MODE")).toBe(true);
    expect(mentions("CONTENT_DELETE_MODE_V2 is different", "CONTENT_DELETE_MODE")).toBe(false);
    expect(mentions("unrelated prose", "CONTENT_DELETE_MODE")).toBe(false);
  });
});
