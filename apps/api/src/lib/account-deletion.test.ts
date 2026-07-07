import { describe, expect, it } from "vitest";
import { resolveDeletionMode } from "./account-deletion.js";

// The deletion-mode gate: only "soft" and "ban" are honored verbatim; everything else — including
// unset config, empty strings, and unrecognized values — MUST fail closed to the safest default,
// "hard" (a full delete). A typo silently downgrading a project to "soft" would be a real defect.
describe("resolveDeletionMode", () => {
  it("passes through the two explicit non-default modes", () => {
    expect(resolveDeletionMode("soft")).toBe("soft");
    expect(resolveDeletionMode("ban")).toBe("ban");
  });

  it("defaults to 'hard' when explicitly configured 'hard'", () => {
    expect(resolveDeletionMode("hard")).toBe("hard");
  });

  it("defaults to 'hard' for unset / empty config", () => {
    expect(resolveDeletionMode(null)).toBe("hard");
    expect(resolveDeletionMode(undefined)).toBe("hard");
    expect(resolveDeletionMode("")).toBe("hard");
  });

  it("defaults to 'hard' for any unrecognized value (case-sensitive, no coercion)", () => {
    expect(resolveDeletionMode("SOFT")).toBe("hard");
    expect(resolveDeletionMode("Ban")).toBe("hard");
    expect(resolveDeletionMode("delete")).toBe("hard");
    expect(resolveDeletionMode(" soft ")).toBe("hard");
  });
});
