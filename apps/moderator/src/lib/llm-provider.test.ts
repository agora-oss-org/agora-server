import { afterEach, describe, expect, it, vi } from "vitest";
import { assess, parseVerdict } from "./llm-provider.js";

afterEach(() => vi.restoreAllMocks());

// Build a Response-like object for a mocked global fetch.
function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) } as Response;
}

describe("parseVerdict", () => {
  it("parses a clean JSON object", () => {
    const v = parseVerdict('{"verdict":"block","categories":["spam"],"confidence":0.92,"reason":"obvious scam"}');
    expect(v).toEqual({ verdict: "block", categories: ["spam"], confidence: 0.92, reason: "obvious scam" });
  });

  it("survives code fences and surrounding prose", () => {
    const v = parseVerdict('Here you go:\n```json\n{"verdict":"allow","categories":[],"confidence":0.8,"reason":"fine"}\n```');
    expect(v.verdict).toBe("allow");
    expect(v.categories).toEqual([]);
  });

  it("clamps confidence to 0..1 and defaults unknown verdicts to review", () => {
    const v = parseVerdict('{"verdict":"nuke","categories":["x",1,null],"confidence":5,"reason":7}');
    expect(v.verdict).toBe("review");
    expect(v.confidence).toBe(1);
    expect(v.categories).toEqual(["x"]); // non-strings dropped
    expect(v.reason).toBe(""); // non-string reason → empty
  });

  it("throws on non-JSON output", () => {
    expect(() => parseVerdict("I refuse to answer")).toThrow();
  });
});

describe("assess (OpenAI-compatible adapter, mocked fetch)", () => {
  it("posts to /chat/completions and returns a normalized verdict + model tag", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      ok({ choices: [{ message: { content: '{"verdict":"block","categories":["harassment"],"confidence":0.95,"reason":"threat"}' } }] })
    );
    const result = await assess({ text: "I will hurt you" });

    expect(result).toEqual({
      verdict: "block",
      categories: ["harassment"],
      confidence: 0.95,
      reason: "threat",
      model: "openai:gpt-4o-mini",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/chat\/completions$/);
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.temperature).toBe(0);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain("I will hurt you");
  });

  it("throws on a non-2xx provider response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" } as Response);
    await expect(assess({ text: "anything" })).rejects.toThrow(/LLM error 429/);
  });
});
