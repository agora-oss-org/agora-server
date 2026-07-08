import { describe, it, expect } from "vitest";
import { isTypeDisabled } from "./notification-prefs.js";

describe("isTypeDisabled", () => {
  it("true when the type is in the disabled set", () => {
    expect(isTypeDisabled(new Set(["message"]), "message")).toBe(true);
  });
  it("false when absent or the set is empty", () => {
    expect(isTypeDisabled(new Set(["new-follow"]), "message")).toBe(false);
    expect(isTypeDisabled(new Set(), "message")).toBe(false);
  });
});
