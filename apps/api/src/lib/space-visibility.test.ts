import { describe, it, expect } from "vitest";
import { discoverableSpacesSql, spaceVisibleToViewer, assertSpaceVisible } from "./space-visibility.js";

// Minimal Hono-context stub. Only the fields the unit reads: c.var.auth, c.var.projectId.
const ctx = (auth?: Record<string, unknown>) => ({ var: { auth, projectId: "p1" } }) as any;
const ADMIN = { userId: "admin", isOperator: false, isProjectOwner: false, isProjectAdmin: true };
const MEMBER = { userId: "u1", isOperator: false, isProjectOwner: false, isProjectAdmin: false };

const space = (visibility: string, userId: string | null = "owner") => ({ id: "s1", userId, visibility });

describe("discoverableSpacesSql", () => {
  it("returns undefined (unfiltered) for a project-admin", () => {
    expect(discoverableSpacesSql(ctx(ADMIN))).toBeUndefined();
  });
  it("returns a defined predicate for an anonymous viewer", () => {
    const sql = discoverableSpacesSql(ctx(undefined));
    expect(sql).not.toBeUndefined();
    expect(typeof sql).toBe("object");
  });
  it("returns a defined predicate for an authenticated non-admin", () => {
    const sql = discoverableSpacesSql(ctx(MEMBER));
    expect(sql).not.toBeUndefined();
    expect(typeof sql).toBe("object");
  });
});

describe("spaceVisibleToViewer (DB-free branches)", () => {
  it("public is visible to anyone, including anonymous", async () => {
    expect(await spaceVisibleToViewer(ctx(undefined), space("public"))).toBe(true);
  });
  it("unlisted is visible to anyone (link-shareable)", async () => {
    expect(await spaceVisibleToViewer(ctx(undefined), space("unlisted"))).toBe(true);
  });
  it("private is visible to a project-admin", async () => {
    expect(await spaceVisibleToViewer(ctx(ADMIN), space("private"))).toBe(true);
  });
  it("private is visible to its owner", async () => {
    expect(await spaceVisibleToViewer(ctx(MEMBER), space("private", "u1"))).toBe(true);
  });
  it("private is hidden from an anonymous viewer", async () => {
    expect(await spaceVisibleToViewer(ctx(undefined), space("private"))).toBe(false);
  });
});

describe("assertSpaceVisible", () => {
  it("resolves for a visible space", async () => {
    await expect(assertSpaceVisible(ctx(undefined), space("public"))).resolves.toBeUndefined();
  });
  it("throws 404 spaces/not-found for a hidden private space (never 403)", async () => {
    await expect(assertSpaceVisible(ctx(undefined), space("private"))).rejects.toMatchObject({
      status: 404,
      code: "spaces/not-found",
    });
  });
});
