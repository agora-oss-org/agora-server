import { describe, it, expect } from "vitest";
import { parseProviders, parseCallbackHash, parseCallbackError, PROVIDER_LABELS } from "./oauth";

describe("parseProviders", () => {
  it("parses a comma-separated list", () => {
    expect(parseProviders("google,github,apple")).toEqual(["google", "github", "apple"]);
  });

  it("trims and lowercases", () => {
    expect(parseProviders(" Google , GITHUB ")).toEqual(["google", "github"]);
  });

  it("drops unknown providers (no label/icon to render)", () => {
    expect(parseProviders("google,myspace")).toEqual(["google"]);
  });

  it("dedupes", () => {
    expect(parseProviders("google,google,github")).toEqual(["google", "github"]);
  });

  it("is empty when unset or blank", () => {
    expect(parseProviders(undefined)).toEqual([]);
    expect(parseProviders("")).toEqual([]);
    expect(parseProviders(" , ")).toEqual([]);
  });

  it("has a label for every supported provider", () => {
    for (const p of parseProviders("google,github,apple")) expect(PROVIDER_LABELS[p]).toBeTruthy();
  });
});

describe("parseCallbackHash", () => {
  it("reads both tokens out of the fragment", () => {
    expect(parseCallbackHash("#accessToken=abc&refreshToken=def")).toEqual({
      accessToken: "abc",
      refreshToken: "def",
    });
  });

  it("decodes percent-encoded values", () => {
    expect(parseCallbackHash("#accessToken=a%2Bb&refreshToken=c%2Fd")?.accessToken).toBe("a+b");
  });

  it("returns null unless BOTH tokens are present", () => {
    expect(parseCallbackHash("#accessToken=abc")).toBeNull();
    expect(parseCallbackHash("#refreshToken=def")).toBeNull();
    expect(parseCallbackHash("#accessToken=&refreshToken=def")).toBeNull();
  });

  it("returns null for an empty or unrelated fragment", () => {
    expect(parseCallbackHash("")).toBeNull();
    expect(parseCallbackHash("#")).toBeNull();
    expect(parseCallbackHash("#section-2")).toBeNull();
  });
});

describe("parseCallbackError", () => {
  it("prefers the human description", () => {
    expect(parseCallbackError("?error=oauth_failed&error_description=Code%20exchange%20failed")).toBe(
      "Code exchange failed",
    );
  });

  it("falls back to the code alone", () => {
    expect(parseCallbackError("?error=access_denied")).toBe("access_denied");
  });

  it("returns null when there is no error", () => {
    expect(parseCallbackError("")).toBeNull();
    expect(parseCallbackError("?foo=bar")).toBeNull();
  });
});
