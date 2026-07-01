import { describe, expect, it } from "vitest";
import { sanitizeUsernameBase } from "./profiles.js";

// The pure email→username-base derivation shared by every "new auth user" path (native/Supabase
// password sign-up, OAuth first-login) via defaultUsername. The DB-backed collision-suffix behavior
// is exercised live in test/integration.
describe("sanitizeUsernameBase", () => {
  it("returns undefined when there's no email", () => {
    expect(sanitizeUsernameBase(undefined)).toBeUndefined();
  });

  it("takes the local-part and lowercases it", () => {
    expect(sanitizeUsernameBase("Alice@Example.com")).toBe("alice");
  });

  it("drops a +tag suffix", () => {
    expect(sanitizeUsernameBase("alice+newsletter@example.com")).toBe("alice");
  });

  it("strips characters outside [a-z0-9_-]", () => {
    expect(sanitizeUsernameBase("a.li.ce!!@example.com")).toBe("a-li-ce");
  });

  it("trims leading/trailing dashes left over from stripping", () => {
    expect(sanitizeUsernameBase("!alice!@example.com")).toBe("alice");
  });

  it("truncates to 30 characters", () => {
    const long = "a".repeat(40);
    expect(sanitizeUsernameBase(`${long}@example.com`)).toBe("a".repeat(30));
  });

  it("falls back to \"user\" when the local-part sanitizes to nothing", () => {
    expect(sanitizeUsernameBase("!!!@example.com")).toBe("user");
  });
});
