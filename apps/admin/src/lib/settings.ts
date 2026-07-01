// Settings API clients. Feed-ranking config maps to GET/PATCH /settings/feed (misc.ts).
// ⚠️ Asymmetric contract: GET returns tunables NESTED under `params`; PATCH takes them FLAT, and a
// `null` value clears a key (resets it to the built-in default). The re-rank webhook secret is
// write-only — GET exposes only `hasSecret`.
import {
  REACTION_TYPES, STEWARD_NOTIFY_POLICIES, STEWARD_MEDIATION_MODES, STEWARD_MEDIATION_ON_CLOSE,
  type StewardNotifyPolicy, type StewardMediationMode, type StewardMediationOnClose, type StewardConfigView,
} from "@agora-server/contract";
// Social-graph config types are the contract's — re-exported so downstream admin code keeps importing
// them from here, but there's a single source of truth (adding a social_config field no longer needs a
// matching hand-edit in this file).
export type { ResolvedSocialConfig, SocialPrivacyTier, SocialConfigPatch, SocialConstellation } from "@agora-server/contract";
import type { ResolvedSocialConfig, SocialConfigPatch, SocialConstellation } from "@agora-server/contract";
import { api } from "./api";

// KNOWN_ALGORITHMS lives in the API's lib/ranking.ts (not the shared contract), so it's mirrored here.
export const FEED_ALGORITHMS = [
  "hot", "top", "new", "controversial", "decay", "gravity", "wilson", "bayesian",
] as const;
export type FeedAlgorithm = (typeof FEED_ALGORITHMS)[number];

export { REACTION_TYPES };
export type ReactionType = (typeof REACTION_TYPES)[number];

export interface RerankWebhookView {
  url: string;
  timeoutMs: number;
  overFetch: number;
  hasSecret: boolean;
}

export interface FeedConfigView {
  defaultAlgorithm: string;
  decayMode: "stored" | "query-time";
  params: { halfLifeHours: number; gravity: number; z: number; C: number; m: number };
  weights: Record<string, number>;
  diversity: { perAuthorCap: number } | null;
  rerankWebhook: RerankWebhookView | null;
}

// Flat PATCH body; omit a key to leave it unchanged, send `null` to reset it to its default.
export interface FeedConfigPatch {
  defaultAlgorithm?: string;
  decayMode?: "stored" | "query-time";
  halfLifeHours?: number;
  gravity?: number;
  z?: number;
  C?: number;
  m?: number;
  reactionWeights?: Record<string, number>;
  diversity?: { perAuthorCap: number } | null;
  rerankWebhook?: { url?: string; secret?: string; timeoutMs?: number; overFetch?: number } | null;
}

export function getFeedConfig(signal?: AbortSignal): Promise<FeedConfigView> {
  return api<FeedConfigView>("/settings/feed", { signal });
}

export function updateFeedConfig(patch: FeedConfigPatch): Promise<FeedConfigView> {
  return api<FeedConfigView>("/settings/feed", { method: "PATCH", body: patch });
}

// ── Project webhooks (GET/PATCH /webhooks/config, POST /webhooks/test) ────────────────────────────
// Validation events are synchronous + blocking (the host replies { valid }); broadcast events
// (`*.complete`, `notification.created`) are fire-and-forget. The set below mirrors what the server
// actually emits.
export const WEBHOOK_VALIDATION_EVENTS = [
  "entity.created", "entity.updated", "comment.created", "comment.updated",
  "space.created", "space.updated", "user.created", "user.updated", "message.created",
] as const;
export const WEBHOOK_BROADCAST_EVENTS = [
  "entity.created.complete", "entity.updated.complete", "comment.created.complete",
  "comment.updated.complete", "space.created.complete", "space.updated.complete",
  "user.created.complete", "user.updated.complete", "message.created.complete", "notification.created",
] as const;

export interface WebhookConfigView {
  url: string | null;
  events: string[];
  hasSecret: boolean; // secret is write-only
}

// PATCH body: omit a key to leave it unchanged. url:null clears the webhook; events:[] disables all.
export interface WebhookConfigPatch {
  url?: string | null;
  secret?: string;
  events?: string[];
}

export interface WebhookTestResult {
  configured: boolean;
  ok?: boolean;
  status?: number;
  error?: string;
}

export function getWebhookConfig(signal?: AbortSignal): Promise<WebhookConfigView> {
  return api<WebhookConfigView>("/webhooks/config", { signal });
}

export function updateWebhookConfig(patch: WebhookConfigPatch): Promise<WebhookConfigView> {
  return api<WebhookConfigView>("/webhooks/config", { method: "PATCH", body: patch });
}

// Pings the SAVED config (ignores the subscribed-event list). 400 if no URL is configured.
export function testWebhook(): Promise<WebhookTestResult> {
  return api<WebhookTestResult>("/webhooks/test", { method: "POST" });
}

// ── Moderator integration (GET/PATCH /settings/moderator) ────────────────────────────────────────
// Per-project tuning for the services/scorer subsystem: the auto-action thresholds + LLM tuning +
// moderation categories the scorer overlays on its env defaults. The LLM API key is write-only — GET
// exposes only hasLlmApiKey. Tuning fields are null when unset (the scorer falls back to its server
// env). (Scoring transport is the scorer's pgmq enqueue — there is no per-project notifier URL.)
export type LlmProvider = "openai" | "anthropic";

export interface ModeratorConfigView {
  blockAutoActionThreshold: number | null;
  reviewAutoActionThreshold: number | null;
  llmProvider: LlmProvider | null;
  llmBaseUrl: string | null;
  llmModel: string | null;
  llmMaxTokens: number | null;
  hasLlmApiKey: boolean;
  categories: string[]; // effective taxonomy (stored, or the seed defaults)
}

// PATCH body: omit a key to leave it unchanged, null to clear it (→ the scorer's env default).
// llmApiKey is write-only (send only when (re)entered).
export interface ModeratorConfigPatch {
  blockAutoActionThreshold?: number | null;
  reviewAutoActionThreshold?: number | null;
  llmProvider?: LlmProvider | null;
  llmBaseUrl?: string | null;
  llmApiKey?: string | null;
  llmModel?: string | null;
  llmMaxTokens?: number | null;
  categories?: string[] | null; // null/[] resets to the seed defaults
}

export function getModeratorConfig(signal?: AbortSignal): Promise<ModeratorConfigView> {
  return api<ModeratorConfigView>("/settings/moderator", { signal });
}

export function updateModeratorConfig(patch: ModeratorConfigPatch): Promise<ModeratorConfigView> {
  return api<ModeratorConfigView>("/settings/moderator", { method: "PATCH", body: patch });
}

// ── Stewardship (GET/PATCH /settings/steward) ─────────────────────────────────────────────────────
// Two knobs: the case-notification policy (who's told about a case, and when) and the mediation policy
// (how channels are run — caucus vs hybrid — and wound down on close).
export { STEWARD_NOTIFY_POLICIES, STEWARD_MEDIATION_MODES, STEWARD_MEDIATION_ON_CLOSE };
export type { StewardNotifyPolicy, StewardMediationMode, StewardMediationOnClose, StewardConfigView };

export function getStewardSettings(signal?: AbortSignal): Promise<StewardConfigView> {
  return api<StewardConfigView>("/settings/steward", { signal });
}

export function updateStewardSettings(
  patch: Partial<{ notifyPolicy: StewardNotifyPolicy; mediationMode: StewardMediationMode; mediationOnClose: StewardMediationOnClose }>,
): Promise<StewardConfigView> {
  return api<StewardConfigView>("/settings/steward", { method: "PATCH", body: patch });
}

// ── Social graph (GET/PATCH /settings/social) ────────────────────────────────────────────────────
// ResolvedSocialConfig / SocialPrivacyTier / SocialConfigPatch come from @agora-server/contract
// (re-exported at the top of this file). Only the admin-shaped view envelope is local.
export interface SocialConfigView {
  stored: Partial<ResolvedSocialConfig>;
  effective: ResolvedSocialConfig;
}

export function getSocialConfig(signal?: AbortSignal): Promise<SocialConfigView> {
  return api<SocialConfigView>("/settings/social", { signal });
}

export function updateSocialConfig(patch: SocialConfigPatch): Promise<SocialConfigView> {
  return api<SocialConfigView>("/settings/social", { method: "PATCH", body: patch });
}

export interface ConstellationRecomputeResult {
  recomputed: boolean;
  constellation: SocialConstellation;
}

/** POST /admin/social/constellation/recompute — force-rematerialize the Constellation snapshot (project-admin). */
export function recomputeConstellation(): Promise<ConstellationRecomputeResult> {
  return api<ConstellationRecomputeResult>("/admin/social/constellation/recompute", { method: "POST" });
}
