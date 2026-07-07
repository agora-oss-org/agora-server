import { describe, it, expect } from "vitest";
import { normalizeUserSearch } from "./user-search.js";

describe("normalizeUserSearch", () => {
  it("no query → no filter, both fields", () => {
    expect(normalizeUserSearch(undefined, undefined)).toEqual({ like: null, fields: ["username", "name"] });
    expect(normalizeUserSearch("   ", undefined)).toEqual({ like: null, fields: ["username", "name"] });
  });
  it("query builds a %like% and defaults to both fields", () => {
    expect(normalizeUserSearch("Ann", undefined)).toEqual({ like: "%Ann%", fields: ["username", "name"] });
  });
  it("searchFields narrows to one field", () => {
    expect(normalizeUserSearch("Ann", "username")).toEqual({ like: "%Ann%", fields: ["username"] });
    expect(normalizeUserSearch("Ann", "name")).toEqual({ like: "%Ann%", fields: ["name"] });
  });
  it("ignores a bogus searchFields (falls back to both)", () => {
    expect(normalizeUserSearch("Ann", "email").fields).toEqual(["username", "name"]);
  });
});
