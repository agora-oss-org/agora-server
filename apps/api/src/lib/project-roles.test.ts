import { describe, it, expect } from "vitest";
import { isProjectAdmin, isProjectOwner } from "./project-roles.js";
import type { AuthContext } from "../http/context.js";

const a = (o: Partial<AuthContext>): AuthContext => ({
  userId: "u", projectId: null, role: "visitor", isOperator: false, isProjectOwner: false, isProjectAdmin: false, isSteward: false, settingsReadonly: false, ...o,
});

describe("project role hierarchy", () => {
  it("operator satisfies every within-project predicate", () => {
    expect(isProjectAdmin(a({ isOperator: true }))).toBe(true);
    expect(isProjectOwner(a({ isOperator: true }))).toBe(true);
  });
  it("owner is a project admin; admin is not an owner", () => {
    expect(isProjectAdmin(a({ isProjectOwner: true }))).toBe(true);
    expect(isProjectOwner(a({ isProjectOwner: true }))).toBe(true);
    expect(isProjectAdmin(a({ isProjectAdmin: true }))).toBe(true);
    expect(isProjectOwner(a({ isProjectAdmin: true }))).toBe(false);
  });
  it("a plain member satisfies nothing", () => {
    expect(isProjectAdmin(a({}))).toBe(false);
    expect(isProjectOwner(a({}))).toBe(false);
  });
});
