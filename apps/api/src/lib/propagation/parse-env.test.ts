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

// A commented shell-command example (not a settable switch) alongside genuine
// commented switches whose values legitimately contain spaces inside <…> placeholders.
const EXAMPLE_WITH_COMMAND = `
#     AGORA_TAG=vX.Y.Z docker compose -f docker-compose.prod.yml --profile selfhost up -d
#SUPABASE_ANON_KEY=<Supabase → Settings → API → anon / publishable>
# TEST_NEO4J_AUTH=neo4j/<password>
#   RATE_LIMIT_MAX=300
ACTIVE_KEY=value
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

const COMPOSE_MODIFIERS = `
services:
  agora:
    environment:
      DATABASE_URL: \${DATABASE_URL:?DATABASE_URL is required}
      IMG: \${AGORA_TAG:+built}
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

  it("skips a commented shell-command example but keeps real <…>-placeholder switches", () => {
    const keys = extractEnvExampleKeys(EXAMPLE_WITH_COMMAND);
    expect(keys.has("AGORA_TAG")).toBe(false); // usage example, not a settable switch
    expect(keys.has("SUPABASE_ANON_KEY")).toBe(true); // spaces are inside <…> only
    expect(keys.has("TEST_NEO4J_AUTH")).toBe(true);
    expect(keys.has("RATE_LIMIT_MAX")).toBe(true);
    expect(keys.has("ACTIVE_KEY")).toBe(true); // active assignments always count
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

  it("matches required-var (:?) and alt (:+) modifier forms, not just default (:-)", () => {
    const keys = extractComposeKeys(COMPOSE_MODIFIERS);
    expect(keys.has("DATABASE_URL")).toBe(true);
    expect(keys.has("AGORA_TAG")).toBe(true);
    expect(keys.has("DB_PORT")).toBe(true);
  });
});

describe("mentions", () => {
  it("matches whole tokens only", () => {
    expect(mentions("set CONTENT_DELETE_MODE=hard to enable", "CONTENT_DELETE_MODE")).toBe(true);
    expect(mentions("CONTENT_DELETE_MODE_V2 is different", "CONTENT_DELETE_MODE")).toBe(false);
    expect(mentions("unrelated prose", "CONTENT_DELETE_MODE")).toBe(false);
  });
});
