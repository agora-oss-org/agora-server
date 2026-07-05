import { describe, expect, it } from "vitest";
import { normalizeOrigin, selectEmailLinkBase } from "./sender.js";

const DEFAULT = "https://agora-oss.org";
const ALLOW = new Set(["https://agora-oss.org", "https://demo.agora-oss.org"]);

describe("normalizeOrigin", () => {
  it("lowercases and strips path/trailing slash to the bare origin", () => {
    expect(normalizeOrigin("https://Demo.Agora-OSS.org/verify?x=1")).toBe("https://demo.agora-oss.org");
    expect(normalizeOrigin("https://demo.agora-oss.org/")).toBe("https://demo.agora-oss.org");
  });
  it("keeps a non-default port", () => {
    expect(normalizeOrigin("http://localhost:5173/auth")).toBe("http://localhost:5173");
  });
  it("returns '' for an unparseable value", () => {
    expect(normalizeOrigin("not a url")).toBe("");
    expect(normalizeOrigin("")).toBe("");
  });
});

describe("selectEmailLinkBase", () => {
  it("returns null when the allowlist is empty — native email REQUIRES a configured allowlist (fail closed)", () => {
    // No allowlist means we can't validate any origin, so we never fall back to a base built from an
    // unvalidated client value — nor to a default that may be the wrong front-end. Caller 503s + warns.
    expect(selectEmailLinkBase("https://evil.com", new Set(), DEFAULT)).toBeNull();
    expect(selectEmailLinkBase("https://demo.agora-oss.org", new Set(), DEFAULT)).toBeNull();
    expect(selectEmailLinkBase(undefined, new Set(), DEFAULT)).toBeNull();
    expect(selectEmailLinkBase(null, new Set(), DEFAULT)).toBeNull();
  });

  it("returns the default when the client sent nothing", () => {
    expect(selectEmailLinkBase(undefined, ALLOW, DEFAULT)).toBe(DEFAULT);
    expect(selectEmailLinkBase(null, ALLOW, DEFAULT)).toBe(DEFAULT);
  });

  it("returns the requested origin when it is allowlisted (normalized match)", () => {
    expect(selectEmailLinkBase("https://demo.agora-oss.org", ALLOW, DEFAULT)).toBe("https://demo.agora-oss.org");
    // trailing slash + case still match the allowlisted origin
    expect(selectEmailLinkBase("https://DEMO.agora-oss.org/", ALLOW, DEFAULT)).toBe("https://demo.agora-oss.org");
  });

  it("returns null (→ caller 400s) for a non-allowlisted origin — the phishing guard", () => {
    expect(selectEmailLinkBase("https://evil.com", ALLOW, DEFAULT)).toBeNull();
    // a look-alike host is NOT a substring match — exact origin only
    expect(selectEmailLinkBase("https://demo.agora-oss.org.evil.com", ALLOW, DEFAULT)).toBeNull();
  });

  it("returns null for an unparseable requested value", () => {
    expect(selectEmailLinkBase("javascript:alert(1)", ALLOW, DEFAULT)).toBeNull();
    expect(selectEmailLinkBase("   ", ALLOW, DEFAULT)).toBeNull();
  });
});
