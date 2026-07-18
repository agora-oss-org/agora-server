import { describe, it, expect } from "vitest";
import { isProjectAdmin, isProjectOwner, assertSettingsWritable } from "./project-roles.js";
import type { AuthContext } from "../http/context.js";
import { ApiError } from "../http/errors.js";

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

// assertSettingsWritable reads c.var.auth.settingsReadonly and throws 403 settings/read-only when set.
// Build a minimal fake Hono context — only c.var.auth is read.
const ctx = (settingsReadonly: boolean) =>
  ({ var: { auth: { settingsReadonly } } }) as unknown as Parameters<typeof assertSettingsWritable>[0];

describe("assertSettingsWritable", () => {
  it("is a no-op when the caller is not settings-read-only", () => {
    expect(() => assertSettingsWritable(ctx(false))).not.toThrow();
  });

  it("throws 403 settings/read-only for a settings-read-only caller", () => {
    try {
      assertSettingsWritable(ctx(true));
      throw new Error("expected assertSettingsWritable to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).code).toBe("settings/read-only");
    }
  });
});
