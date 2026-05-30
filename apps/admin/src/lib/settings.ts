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
