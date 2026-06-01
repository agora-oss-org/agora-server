import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt, DEFAULT_MODERATION_CATEGORIES } from "./policy.js";

describe("buildSystemPrompt", () => {
  it("lists the given categories in the prompt", () => {
    const prompt = buildSystemPrompt(["spam", "scams", "phishing"]);
    expect(prompt).toContain("Categories: spam, scams, phishing.");
    expect(prompt).toContain('"verdict"'); // still pins the JSON contract
  });

  it("falls back to the default taxonomy when given an empty list", () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toContain(`Categories: ${DEFAULT_MODERATION_CATEGORIES.join(", ")}.`);
  });
});

describe("buildUserPrompt", () => {
  it("includes context only when provided", () => {
    expect(buildUserPrompt({ text: "hi" })).not.toContain("CONTEXT");
    expect(buildUserPrompt({ text: "hi", context: "parent" })).toContain("CONTEXT");
  });
});
