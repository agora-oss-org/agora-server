import { describe, expect, it } from "vitest";
import { mentionIds } from "./notifications.js";

describe("mentionIds", () => {
  it("excludes #space mention tokens (not a notification recipient)", () => {
    expect(mentionIds([{ type: "space", id: "s1", slug: "dev" }])).toEqual([]);
  });

  it("includes #user mention tokens", () => {
    expect(mentionIds([{ type: "user", id: "u1", username: "a" }])).toEqual(["u1"]);
  });

  it("includes user tokens and excludes space tokens in a mixed array", () => {
    expect(
      mentionIds([
        { type: "space", id: "s1", slug: "d" },
        { type: "user", id: "u1", username: "a" },
      ])
    ).toEqual(["u1"]);
  });

  it("still includes legacy untyped objects", () => {
    expect(mentionIds([{ id: "u2" }])).toEqual(["u2"]);
  });

  it("still includes bare string ids", () => {
    expect(mentionIds(["u3"])).toEqual(["u3"]);
  });

  it("returns an empty array for non-array input", () => {
    expect(mentionIds("not-an-array")).toEqual([]);
    expect(mentionIds(undefined)).toEqual([]);
    expect(mentionIds(null)).toEqual([]);
  });
});
