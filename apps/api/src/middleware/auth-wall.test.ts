// The auth wall's pure logic: path derivation + allowlist membership. The wall's HTTP behavior
// (401/403/pass) is covered by test/integration/auth-wall.test.ts against the real app; these
// tests pin the decision logic and the EXACT anonymous surface (a membership change must fail here).
import { describe, it, expect } from "vitest";
import { AUTH_WALL_ALLOWLIST, projectRelativePath, isWallAllowlisted } from "./auth.js";

describe("AUTH_WALL_ALLOWLIST", () => {
  it("pins the exact anonymous surface of the API", () => {
    expect(AUTH_WALL_ALLOWLIST.prefixes).toEqual(["/auth/", "/public/"]);
    expect(AUTH_WALL_ALLOWLIST.exact).toEqual([
      "/oauth/authorize",
      "/oauth/callback",
      "/projects/lean",
      "/push-notifications/vapid-public-key",
      "/crypto/sign-testing-jwt/v2",
    ]);
  });
});

describe("projectRelativePath", () => {
  it("strips /v7/<projectId> and keeps the rest", () => {
    expect(projectRelativePath("/v7/11111111-1111-1111-1111-111111111111/auth/sign-in"))
      .toBe("/auth/sign-in");
    expect(projectRelativePath("/v7/11111111-1111-1111-1111-111111111111/entities"))
      .toBe("/entities");
    expect(projectRelativePath("/v7/11111111-1111-1111-1111-111111111111/chat/conversations/abc/messages"))
      .toBe("/chat/conversations/abc/messages");
  });
});

describe("isWallAllowlisted", () => {
  it("admits the /auth/ prefix", () => {
    expect(isWallAllowlisted("/auth/sign-in")).toBe(true);
    expect(isWallAllowlisted("/auth/request-new-access-token")).toBe(true);
  });
  it("admits the /public/ prefix (anonymous internet-public reads)", () => {
    expect(isWallAllowlisted("/public/entities/abc")).toBe(true);
    expect(isWallAllowlisted("/public/entities/abc/comments/thread")).toBe(true);
  });
  it("admits exact members only", () => {
    expect(isWallAllowlisted("/projects/lean")).toBe(true);
    expect(isWallAllowlisted("/oauth/callback")).toBe(true);
    expect(isWallAllowlisted("/push-notifications/vapid-public-key")).toBe(true);
    expect(isWallAllowlisted("/crypto/sign-testing-jwt/v2")).toBe(true);
  });
  it("rejects near-misses (fail closed)", () => {
    expect(isWallAllowlisted("/authx/anything")).toBe(false);      // prefix must not over-match
    expect(isWallAllowlisted("/auth")).toBe(false);                 // bare /auth is not a route
    expect(isWallAllowlisted("/publicx/anything")).toBe(false);    // prefix must not over-match
    expect(isWallAllowlisted("/public")).toBe(false);              // bare /public is not a route
    expect(isWallAllowlisted("/oauth/identities")).toBe(false);     // authed oauth stays walled
    expect(isWallAllowlisted("/projects/lean/extra")).toBe(false);  // exact means exact
    expect(isWallAllowlisted("/entities")).toBe(false);
    expect(isWallAllowlisted("/search/content")).toBe(false);
    expect(isWallAllowlisted("/users/suggestions")).toBe(false);
  });
});
