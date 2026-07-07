import { describe, it, expect } from "vitest";
import { validateSpaceReputationParams } from "./space-reputation.js";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("validateSpaceReputationParams", () => {
  it("user-direct rejects 'context'", () => {
    expect(() => validateSpaceReputationParams({ spaceReputationId: "context" }, "user-direct")).toThrow();
  });
  it("context endpoints accept 'context'", () => {
    expect(() => validateSpaceReputationParams({ spaceReputationId: "context" }, "context")).not.toThrow();
  });
  it("both classes accept 'none' and a uuid", () => {
    for (const cls of ["context", "user-direct"] as const) {
      expect(() => validateSpaceReputationParams({ spaceReputationId: "none" }, cls)).not.toThrow();
      expect(() => validateSpaceReputationParams({ spaceReputationId: UUID }, cls)).not.toThrow();
    }
  });
  it("rejects a non-uuid garbage id", () => {
    expect(() => validateSpaceReputationParams({ spaceReputationId: "garbage" }, "context")).toThrow();
  });
  it("absent param is a no-op", () => {
    expect(() => validateSpaceReputationParams({}, "user-direct")).not.toThrow();
  });
  it("descendants=true is only valid with an explicit uuid", () => {
    expect(() => validateSpaceReputationParams({ spaceReputationId: "none", spaceReputationDescendants: "true" }, "context")).toThrow();
    expect(() => validateSpaceReputationParams({ spaceReputationId: UUID, spaceReputationDescendants: "true" }, "context")).not.toThrow();
  });
});
