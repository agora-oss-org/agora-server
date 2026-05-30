// Settings API clients. Feed-ranking config maps to GET/PATCH /settings/feed (misc.ts).
// ⚠️ Asymmetric contract: GET returns tunables NESTED under `params`; PATCH takes them FLAT, and a
// `null` value clears a key (resets it to the built-in default). The re-rank webhook secret is
// write-only — GET exposes only `hasSecret`.
import { REACTION_TYPES } from "@agora/contract";
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
