// Ladder predicate matrix (spec §3): public AND not deleted AND not draft AND not removed AND
// (spaceless OR live public space). Pure — the DB-backed assert is covered by
// test/integration/public-read.test.ts.
import { describe, it, expect } from "vitest";
import { isInternetPublic } from "./public-access.js";

const base = { isPublic: true, deletedAt: null, isDraft: false, moderationStatus: null, spaceId: null };
const pubSpace = { readingPermission: "anyone", deletedAt: null };

describe("isInternetPublic", () => {
  it("admits a public, live, spaceless entity", () => {
    expect(isInternetPublic(base, null)).toBe(true);
  });
  it("admits a public entity in a live public space", () => {
    expect(isInternetPublic({ ...base, spaceId: "s1" }, pubSpace)).toBe(true);
  });
  it("rejects when the flag is off", () => {
    expect(isInternetPublic({ ...base, isPublic: false }, null)).toBe(false);
  });
  it("rejects deleted / draft / moderation-removed", () => {
    expect(isInternetPublic({ ...base, deletedAt: new Date() }, null)).toBe(false);
    expect(isInternetPublic({ ...base, isDraft: true }, null)).toBe(false);
    expect(isInternetPublic({ ...base, moderationStatus: "removed" }, null)).toBe(false);
  });
  it("rejects a members-only, deleted, or missing space (fail closed)", () => {
    expect(isInternetPublic({ ...base, spaceId: "s1" }, { readingPermission: "members", deletedAt: null })).toBe(false);
    expect(isInternetPublic({ ...base, spaceId: "s1" }, { readingPermission: "anyone", deletedAt: new Date() })).toBe(false);
    expect(isInternetPublic({ ...base, spaceId: "s1" }, null)).toBe(false);
  });
  it("ignores an approved moderation status", () => {
    expect(isInternetPublic({ ...base, moderationStatus: "approved" }, null)).toBe(true);
  });
});
