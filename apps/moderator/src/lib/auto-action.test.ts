import { describe, expect, it } from "vitest";
import { decideAutoAction } from "./auto-action.js";

// Two independent confidence floors: one for "block" verdicts, one for "review" verdicts. A floor of
// 0 disables that path entirely. Only entity/comment are removable via the API write-back.
const TH = { blockAutoActionThreshold: 0.85, reviewAutoActionThreshold: 0.9 };

describe("decideAutoAction", () => {
  it("auto-acts a block at/above the block threshold", () => {
    expect(decideAutoAction("block", 0.85, "entity", TH)).toBe("block");
    expect(decideAutoAction("block", 0.99, "comment", TH)).toBe("block");
  });

  it("does not auto-act a block below the block threshold", () => {
    expect(decideAutoAction("block", 0.84, "entity", TH)).toBeNull();
  });

  it("never auto-acts a block when the block threshold is 0 (disabled)", () => {
    expect(decideAutoAction("block", 1, "entity", { blockAutoActionThreshold: 0, reviewAutoActionThreshold: 0.9 })).toBeNull();
  });

  it("auto-acts a review at/above the review threshold", () => {
    expect(decideAutoAction("review", 0.9, "entity", TH)).toBe("review");
    expect(decideAutoAction("review", 0.95, "comment", TH)).toBe("review");
  });

  it("does not auto-act a review below the review threshold", () => {
    expect(decideAutoAction("review", 0.89, "entity", TH)).toBeNull();
  });

  it("never auto-acts a review when the review threshold is 0 (the default / today's behavior)", () => {
    expect(decideAutoAction("review", 1, "entity", { blockAutoActionThreshold: 0.85, reviewAutoActionThreshold: 0 })).toBeNull();
  });

  it("never auto-acts an allow verdict", () => {
    expect(decideAutoAction("allow", 1, "entity", TH)).toBeNull();
  });

  it("never auto-acts a non-removable target (message), even when eligible by confidence", () => {
    expect(decideAutoAction("block", 1, "message", TH)).toBeNull();
    expect(decideAutoAction("review", 1, "message", TH)).toBeNull();
  });
});
