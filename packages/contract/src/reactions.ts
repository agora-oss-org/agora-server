// ─── Reaction taxonomy (must match db enum + SDK exactly) ────────────────────
export const REACTION_TYPES = [
  "upvote",
  "downvote",
  "like",
  "love",
  "wow",
  "sad",
  "angry",
  "funny",
] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];
export type ReactionCounts = Record<ReactionType, number>;
