import { describe, it, expect } from "vitest";
import { rewritePublicAuthUrl, isAllowedRedirect, resolveRedirectAllowlist } from "./oauth.js";

const INTERNAL = "http://proxy:9998";
const AUTHORIZE = `${INTERNAL}/auth/v1/authorize?provider=google&redirect_to=x&code_challenge=y`;

describe("rewritePublicAuthUrl", () => {
  it("swaps the internal SUPABASE_URL origin for the public one", () => {
    expect(rewritePublicAuthUrl(AUTHORIZE, INTERNAL, "http://localhost")).toBe(
      "http://localhost/auth/v1/authorize?provider=google&redirect_to=x&code_challenge=y",
    );
  });

  it("tolerates trailing slashes on either base", () => {
    expect(rewritePublicAuthUrl(AUTHORIZE, "http://proxy:9998/", "https://agora.example.org/")).toBe(
      "https://agora.example.org/auth/v1/authorize?provider=google&redirect_to=x&code_challenge=y",
    );
  });

  it("returns the url unchanged when no public base is configured (cloud Supabase)", () => {
    expect(rewritePublicAuthUrl(AUTHORIZE, INTERNAL, undefined)).toBe(AUTHORIZE);
  });

  it("returns the url unchanged when it does not start with the internal base", () => {
    const cloud = "https://ref.supabase.co/auth/v1/authorize?provider=google";
    expect(rewritePublicAuthUrl(cloud, INTERNAL, "http://localhost")).toBe(cloud);
  });

  it("returns the url unchanged when the internal base is unset", () => {
    expect(rewritePublicAuthUrl(AUTHORIZE, undefined, "http://localhost")).toBe(AUTHORIZE);
  });
});

describe("resolveRedirectAllowlist", () => {
  it("splits and trims an explicit list", () => {
    expect(resolveRedirectAllowlist("http://localhost, https://app.example.org ", undefined)).toEqual([
      "http://localhost",
      "https://app.example.org",
    ]);
  });

  it("falls back to PUBLIC_BASE_URL when the list is unset", () => {
    expect(resolveRedirectAllowlist(undefined, "http://localhost")).toEqual(["http://localhost"]);
  });

  it("prefers the explicit list over PUBLIC_BASE_URL", () => {
    expect(resolveRedirectAllowlist("https://a.example", "http://localhost")).toEqual(["https://a.example"]);
  });

  it("is empty when neither is configured (caller fails closed)", () => {
    expect(resolveRedirectAllowlist(undefined, undefined)).toEqual([]);
    expect(resolveRedirectAllowlist("  ,  ", undefined)).toEqual([]);
  });
});

describe("isAllowedRedirect", () => {
  const ALLOW = ["http://localhost", "https://app.example.org"];

  it("allows any path/query on an allowlisted origin", () => {
    expect(isAllowedRedirect("http://localhost/login", ALLOW)).toBe(true);
    expect(isAllowedRedirect("https://app.example.org/auth?x=1", ALLOW)).toBe(true);
  });

  it("rejects another origin", () => {
    expect(isAllowedRedirect("https://evil.example/steal", ALLOW)).toBe(false);
  });

  it("rejects a prefix-confusion host", () => {
    expect(isAllowedRedirect("http://localhost.evil.example/", ALLOW)).toBe(false);
  });

  it("rejects a port or scheme mismatch", () => {
    expect(isAllowedRedirect("http://localhost:8080/", ALLOW)).toBe(false);
    expect(isAllowedRedirect("https://localhost/", ALLOW)).toBe(false);
  });

  it("rejects protocol-relative and malformed targets", () => {
    expect(isAllowedRedirect("//evil.example", ALLOW)).toBe(false);
    expect(isAllowedRedirect("not a url", ALLOW)).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)", ALLOW)).toBe(false);
  });

  it("rejects everything when the allowlist is empty", () => {
    expect(isAllowedRedirect("http://localhost/login", [])).toBe(false);
  });

  it("allows a mobile deep link only when its scheme prefix is allowlisted", () => {
    expect(isAllowedRedirect("myapp://auth/callback", ["myapp://"])).toBe(true);
    expect(isAllowedRedirect("otherapp://auth/callback", ["myapp://"])).toBe(false);
  });
});
