// Resolves a project's effective moderator settings: the per-project overrides authored by the API
// (admin Settings → Moderator, stored in projects.moderator_config) merged over this service's env
// defaults. Any unset override falls back to env — so a single-project deployment can run on env
// alone, while a multi-tenant one tunes each project from the admin. Cached 30s, mirroring the
// API's own config caches (webhook-verify.ts, the API's lib/webhooks.ts).
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { type LlmConfig, envLlm } from "./llm-provider.js";

export interface ResolvedModeratorConfig {
  autoActionThreshold: number; // 0..1; 0 disables auto-removal (everything queues for a human)
  llm: LlmConfig;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedModeratorConfig; at: number }>();

function resolve(raw: unknown): ResolvedModeratorConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const base = envLlm();
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    autoActionThreshold:
      typeof r.autoActionThreshold === "number" && Number.isFinite(r.autoActionThreshold)
        ? Math.min(1, Math.max(0, r.autoActionThreshold))
        : env.MODERATION_AUTO_ACTION_THRESHOLD,
    llm: {
      provider: r.llmProvider === "anthropic" || r.llmProvider === "openai" ? r.llmProvider : base.provider,
      baseUrl: typeof r.llmBaseUrl === "string" && r.llmBaseUrl ? r.llmBaseUrl : base.baseUrl,
      apiKey: typeof r.llmApiKey === "string" && r.llmApiKey ? r.llmApiKey : base.apiKey,
      model: typeof r.llmModel === "string" && r.llmModel ? r.llmModel : base.model,
      maxTokens: num(r.llmMaxTokens, base.maxTokens),
    },
  };
}

export async function getModeratorConfig(projectId: string): Promise<ResolvedModeratorConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cfg;
  const [p] = await db
    .select({ cfg: projects.moderatorConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const cfg = resolve(p?.cfg);
  // Debug the RESOLVED config (override ?? env) — provider/model/threshold + whether a key resolved,
  // never the key itself. Logged on cache miss (≤ once per 30s per project).
  logger.debug(
    {
      projectId,
      provider: cfg.llm.provider, model: cfg.llm.model, baseUrl: cfg.llm.baseUrl ?? null,
      maxTokens: cfg.llm.maxTokens, threshold: cfg.autoActionThreshold, llmKeyResolved: !!cfg.llm.apiKey,
    },
    "moderation: resolved project config",
  );
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}
