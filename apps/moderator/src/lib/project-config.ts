// Resolves a project's effective moderator settings: the per-project overrides authored by the API
// (admin Settings → Moderator, stored in projects.moderator_config) merged over this service's env
// defaults. Any unset override falls back to env — so a single-project deployment can run on env
// alone, while a multi-tenant one tunes each project from the admin. Cached 30s, mirroring the
// API's own config caches (webhook-verify.ts, the API's lib/webhooks.ts).
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { type LlmConfig, envLlm } from "./llm-provider.js";
import { DEFAULT_MODERATION_CATEGORIES } from "./policy.js";

export interface ResolvedModeratorConfig {
  blockAutoActionThreshold: number; // 0..1; 0 disables block auto-removal (queues for a human)
  reviewAutoActionThreshold: number; // 0..1; 0 disables review auto-removal (the default)
  llm: LlmConfig;
  categories: string[]; // the per-project moderation taxonomy (seeded from DEFAULT_MODERATION_CATEGORIES)
}

// A stored categories override is used only when it's a non-empty array of non-blank strings.
function resolveCategories(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const list = raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
    if (list.length) return list;
  }
  return [...DEFAULT_MODERATION_CATEGORIES];
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedModeratorConfig; at: number }>();

function resolve(raw: unknown): ResolvedModeratorConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const base = envLlm();
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  // A threshold override is used only when it's a finite number, clamped to 0..1; else the env default.
  const threshold = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  return {
    blockAutoActionThreshold: threshold(r.blockAutoActionThreshold, env.MODERATION_BLOCK_AUTO_ACTION_THRESHOLD),
    reviewAutoActionThreshold: threshold(r.reviewAutoActionThreshold, env.MODERATION_REVIEW_AUTO_ACTION_THRESHOLD),
    llm: {
      provider: r.llmProvider === "anthropic" || r.llmProvider === "openai" ? r.llmProvider : base.provider,
      baseUrl: typeof r.llmBaseUrl === "string" && r.llmBaseUrl ? r.llmBaseUrl : base.baseUrl,
      apiKey: typeof r.llmApiKey === "string" && r.llmApiKey ? r.llmApiKey : base.apiKey,
      model: typeof r.llmModel === "string" && r.llmModel ? r.llmModel : base.model,
      maxTokens: num(r.llmMaxTokens, base.maxTokens),
    },
    categories: resolveCategories(r.categories),
  };
}

// Seed the default taxonomy into a project that has none yet, so the admin shows an editable starting
// list. Atomic + idempotent (only writes when the key is absent); best-effort (failures are logged).
async function seedCategoriesIfMissing(projectId: string, raw: unknown): Promise<void> {
  const has = Array.isArray((raw as Record<string, any>)?.categories) && (raw as Record<string, any>).categories.length > 0;
  if (has) return;
  try {
    await db.execute(sql`
      update projects
      set moderator_config = jsonb_set(coalesce(moderator_config, '{}'::jsonb), '{categories}', ${JSON.stringify([...DEFAULT_MODERATION_CATEGORIES])}::jsonb, true)
      where id = ${projectId}::uuid and (moderator_config -> 'categories') is null
    `);
    logger.info({ projectId, count: DEFAULT_MODERATION_CATEGORIES.length }, "moderation: seeded default categories");
  } catch (err) {
    logger.error({ err, projectId }, "moderation: failed to seed default categories");
  }
}

export async function getModeratorConfig(projectId: string): Promise<ResolvedModeratorConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cfg;
  const [p] = await db
    .select({ cfg: projects.moderatorConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  // Persist the seed categories the first time we see a project without any (so they're editable in
  // admin). The resolved value already falls back to the defaults, so this is just persistence.
  await seedCategoriesIfMissing(projectId, p?.cfg);
  const cfg = resolve(p?.cfg);
  // Debug the RESOLVED config (override ?? env) — provider/model/threshold + whether a key resolved,
  // never the key itself. Logged on cache miss (≤ once per 30s per project).
  logger.debug(
    {
      projectId,
      provider: cfg.llm.provider, model: cfg.llm.model, baseUrl: cfg.llm.baseUrl ?? null,
      maxTokens: cfg.llm.maxTokens,
      blockThreshold: cfg.blockAutoActionThreshold, reviewThreshold: cfg.reviewAutoActionThreshold,
      llmKeyResolved: !!cfg.llm.apiKey,
    },
    "moderation: resolved project config",
  );
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}
