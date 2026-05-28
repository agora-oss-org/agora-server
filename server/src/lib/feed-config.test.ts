import { describe, it, expect } from "vitest";
import { feedConfigView, type ResolvedFeedConfig } from "./feed-config.js";

const base: ResolvedFeedConfig = {
  defaultAlgorithm: "hot",
  decayMode: "query-time",
  params: { halfLifeHours: 24, gravity: 1.8, z: 1.96, C: 10, m: 0.5 },
  weights: { upvote: 1, downvote: 1, like: 1, love: 2, wow: 1, sad: 0, angry: 0, funny: 1 },
  diversity: { perAuthorCap: 3 },
  rerankWebhook: null,
};

describe("feedConfigView", () => {
  it("redacts the re-rank webhook secret (hasSecret flag, no secret field)", () => {
    const view = feedConfigView({
      ...base,
      rerankWebhook: { url: "https://host/rerank", secret: "whsec_super", timeoutMs: 4000, overFetch: 3 },
    });
    expect(view.rerankWebhook).toEqual({
      url: "https://host/rerank",
      timeoutMs: 4000,
      overFetch: 3,
      hasSecret: true,
    });
    // the raw secret must never appear in the serialized view
    expect(JSON.stringify(view)).not.toContain("whsec_super");
  });

  it("passes through a null re-rank webhook as null", () => {
    expect(feedConfigView(base).rerankWebhook).toBeNull();
  });

  it("preserves the non-secret config fields", () => {
    const view = feedConfigView(base);
    expect(view.defaultAlgorithm).toBe("hot");
    expect(view.decayMode).toBe("query-time");
    expect(view.params).toEqual(base.params);
    expect(view.weights).toEqual(base.weights);
    expect(view.diversity).toEqual({ perAuthorCap: 3 });
  });
});
