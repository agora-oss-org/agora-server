import { describe, it, expect } from "vitest";
import { isDirty } from "./dirty";

describe("isDirty", () => {
  it("is false for identical primitives and structures", () => {
    expect(isDirty(1, 1)).toBe(false);
    expect(isDirty("a", "a")).toBe(false);
    expect(isDirty({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(false);
  });

  it("ignores object key order", () => {
    expect(isDirty({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(isDirty({ x: { p: 1, q: 2 } }, { x: { q: 2, p: 1 } })).toBe(false);
  });

  it("is true when a value changes", () => {
    expect(isDirty({ a: 1 }, { a: 2 })).toBe(true);
    expect(isDirty("0.850", "0.85")).toBe(true);
    expect(isDirty({ a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it("treats array order as significant", () => {
    expect(isDirty([1, 2], [2, 1])).toBe(true);
    expect(isDirty(["a", "b"], ["a", "b"])).toBe(false);
  });

  it("treats null and undefined as the same 'no value' (not an edit)", () => {
    expect(isDirty({ a: null }, { a: undefined })).toBe(false);
    expect(isDirty(null, null)).toBe(false);
  });

  it("distinguishes empty string from null", () => {
    expect(isDirty({ a: "" }, { a: null })).toBe(true);
  });

  it("detects a write-only secret being (re)entered via its flag", () => {
    const base = { url: "https://x", events: ["a", "b"], secretDirty: false };
    expect(isDirty({ ...base }, base)).toBe(false);
    expect(isDirty({ ...base, secretDirty: true }, base)).toBe(true);
  });
});
