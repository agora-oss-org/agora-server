import { describe, it, expect } from "vitest";
import { removedPolicy, excludeRemovedSql, shouldHide } from "./moderation-visibility.js";
import { entities, comments } from "../db/schema/index.js";

const PRIVILEGED = { privileged: true };
const NON_PRIVILEGED = { privileged: false };

describe("shouldHide", () => {
  it("hides removed content from non-privileged viewers", () => {
    expect(shouldHide(NON_PRIVILEGED, "removed")).toBe(true);
  });

  it("does not hide non-removed statuses from non-privileged viewers", () => {
    expect(shouldHide(NON_PRIVILEGED, null)).toBe(false);
    expect(shouldHide(NON_PRIVILEGED, undefined)).toBe(false);
    expect(shouldHide(NON_PRIVILEGED, "approved")).toBe(false);
    expect(shouldHide(NON_PRIVILEGED, "pending")).toBe(false);
  });

  it("never hides anything from privileged viewers", () => {
    expect(shouldHide(PRIVILEGED, "removed")).toBe(false);
    expect(shouldHide(PRIVILEGED, "approved")).toBe(false);
    expect(shouldHide(PRIVILEGED, null)).toBe(false);
  });
});

describe("excludeRemovedSql", () => {
  it("returns undefined for privileged viewers (so callers can conditionally push)", () => {
    expect(excludeRemovedSql(PRIVILEGED, entities)).toBeUndefined();
    expect(excludeRemovedSql(PRIVILEGED, comments)).toBeUndefined();
  });

  it("returns a defined SQL object for non-privileged viewers on entities", () => {
    const sql = excludeRemovedSql(NON_PRIVILEGED, entities);
    expect(sql).not.toBeUndefined();
    expect(typeof sql).toBe("object");
  });

  it("returns a defined SQL object for non-privileged viewers on comments", () => {
    const sql = excludeRemovedSql(NON_PRIVILEGED, comments);
    expect(sql).not.toBeUndefined();
    expect(typeof sql).toBe("object");
  });
});

describe("removedPolicy", () => {
  it("marks operators as privileged", async () => {
    const c = { var: { auth: { isOperator: true } } } as any;
    expect(await removedPolicy(c)).toEqual({ privileged: true });
  });

  it("marks non-operators as non-privileged", async () => {
    const c = { var: { auth: { isOperator: false } } } as any;
    expect(await removedPolicy(c)).toEqual({ privileged: false });
  });

  it("treats an absent auth context as non-privileged", async () => {
    const c = { var: {} } as any;
    expect(await removedPolicy(c)).toEqual({ privileged: false });
  });
});
