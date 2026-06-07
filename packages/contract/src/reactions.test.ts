import { describe, it, expect } from "vitest";
import { REACTION_TYPES } from "./reactions.js";

describe("reaction taxonomy", () => {
  it("is exactly the agreed set, in order (must match the DB enum + SDK)", () => {
    expect(REACTION_TYPES).toEqual([
      "upvote",
      "downvote",
      "like",
      "love",
      "wow",
      "sad",
      "angry",
      "funny",
    ]);
  });

  it("contains no duplicates", () => {
    expect(new Set(REACTION_TYPES).size).toBe(REACTION_TYPES.length);
  });

  it("keeps the v6 vote types that feeds + scoring rely on", () => {
    expect(REACTION_TYPES).toContain("upvote");
    expect(REACTION_TYPES).toContain("downvote");
  });
});
