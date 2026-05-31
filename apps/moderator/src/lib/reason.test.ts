import { describe, it, expect } from "vitest";
import { moderationReasonText } from "./reason.js";

describe("moderationReasonText", () => {
  it("prefixes the verdict + rounded score before the model's reason", () => {
    expect(moderationReasonText({ verdict: "review", confidence: 0.6, reason: "advertises illicit drugs" }))
      .toBe("AI review (60% confidence): advertises illicit drugs");
  });

  it("rounds the confidence to a whole percent", () => {
    expect(moderationReasonText({ verdict: "block", confidence: 0.876, reason: "spam" }))
      .toBe("AI block (88% confidence): spam");
  });

  it("omits the body when there's no reason", () => {
    expect(moderationReasonText({ verdict: "block", confidence: 1, reason: "" })).toBe("AI block (100% confidence)");
    expect(moderationReasonText({ verdict: "block", confidence: 1, reason: null })).toBe("AI block (100% confidence)");
  });

  it("treats a non-finite confidence as 0%", () => {
    expect(moderationReasonText({ verdict: "review", confidence: NaN, reason: "x" })).toBe("AI review (0% confidence): x");
  });
});
