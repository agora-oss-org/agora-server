import { describe, it, expect } from "vitest";
import { rewritePublicAuthUrl } from "./oauth.js";

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
