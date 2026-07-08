import { describe, it, expect } from "vitest";
import { fillReputationMap, validateSpaceReputationParams } from "./space-reputation.js";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("fillReputationMap", () => {
  it("defaults every requested id to 0", () => {
    expect(fillReputationMap([], ["a", "b"])).toEqual(new Map([["a", 0], ["b", 0]]));
  });
  it("fills present rows and leaves absent ids at 0", () => {
    const m = fillReputationMap([{ userId: "a", reputation: 5 }], ["a", "b"]);
    expect(m.get("a")).toBe(5);
    expect(m.get("b")).toBe(0);
  });
  it("ignores rows for ids that were not requested", () => {
    const m = fillReputationMap([{ userId: "z", reputation: 9 }], ["a"]);
    expect(m.has("z")).toBe(false);
    expect(m.get("a")).toBe(0);
  });
});

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
  it("descendants=true with an ABSENT id throws", () => {
    expect(() => validateSpaceReputationParams({ spaceReputationDescendants: "true" }, "context")).toThrow();
  });
});
