import { describe, expect, it } from "vitest";
import { fillReputationMap } from "./space-reputation.js";

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
