import { describe, it, expect } from "vitest";
import { baseUrl, bool, httpUrl, nonEmpty, resolve, resolveBool, runtimeConfig, uuid } from "./runtime-config";

describe("httpUrl", () => {
  it("accepts http and https origins", () => {
    expect(httpUrl("https://agora.example.org/")).toBe("https://agora.example.org/");
    expect(httpUrl("http://localhost:5174/")).toBe("http://localhost:5174/");
    expect(httpUrl("  https://agora.example.org/demo/  ")).toBe("https://agora.example.org/demo/");
  });

  it("rejects non-web schemes — the value ends up in an <a href>", () => {
    expect(httpUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(httpUrl("file:///etc/passwd")).toBeUndefined();
  });

  it("rejects malformed and unset values", () => {
    expect(httpUrl("not a url")).toBeUndefined();
    expect(httpUrl("<your.domain>")).toBeUndefined(); // unsubstituted .env placeholder
    expect(httpUrl("")).toBeUndefined();
    expect(httpUrl(undefined)).toBeUndefined();
  });

  it("lets a rejected candidate fall through to the next one", () => {
    expect(resolve(httpUrl("javascript:alert(1)"), httpUrl("https://ok.example/"))).toBe("https://ok.example/");
  });
});

describe("nonEmpty", () => {
  it("keeps non-blank strings, trimmed", () => {
    expect(nonEmpty("https://app.example.org/")).toBe("https://app.example.org/");
    expect(nonEmpty("  https://app.example.org/  ")).toBe("https://app.example.org/");
  });

  it("treats blank and non-string values as unset", () => {
    expect(nonEmpty("")).toBeUndefined();
    expect(nonEmpty("   ")).toBeUndefined();
    expect(nonEmpty(undefined)).toBeUndefined();
    expect(nonEmpty(null)).toBeUndefined();
    expect(nonEmpty(42)).toBeUndefined();
    expect(nonEmpty({})).toBeUndefined();
  });
});

describe("resolve", () => {
  it("takes the first non-blank candidate, in order", () => {
    expect(resolve("runtime", "build", "default")).toBe("runtime");
    expect(resolve(undefined, "build", "default")).toBe("build");
    expect(resolve(undefined, "", "default")).toBe("default");
  });

  it("returns undefined when nothing is set", () => {
    expect(resolve(undefined, "", null)).toBeUndefined();
    expect(resolve()).toBeUndefined();
  });
});

describe("baseUrl", () => {
  it("accepts root-relative same-origin paths, trailing slashes stripped", () => {
    expect(baseUrl("/v7")).toBe("/v7");
    expect(baseUrl("/v7/")).toBe("/v7");
    expect(baseUrl("/api/v7///")).toBe("/api/v7");
  });

  it("accepts absolute http(s) bases for a cross-origin API", () => {
    expect(baseUrl("https://api.example.org/v7")).toBe("https://api.example.org/v7");
    expect(baseUrl("http://localhost:4000/v7/")).toBe("http://localhost:4000/v7");
  });

  it("rejects protocol-relative values — they silently repoint API calls off-origin", () => {
    // Reads like a path, but the browser treats it as an origin: every request (and the Bearer
    // token it carries) would go to evil.example instead of same-origin.
    expect(baseUrl("//evil.example/v7")).toBeUndefined();
    expect(baseUrl("//evil.example")).toBeUndefined();
  });

  it("rejects non-web schemes and junk", () => {
    expect(baseUrl("javascript:alert(1)")).toBeUndefined();
    expect(baseUrl("ftp://example.org/v7")).toBeUndefined();
    expect(baseUrl("v7")).toBeUndefined(); // not rooted, not absolute
    expect(baseUrl("")).toBeUndefined();
  });
});

describe("uuid", () => {
  it("accepts a uuid, normalised to lowercase", () => {
    expect(uuid("11111111-1111-1111-1111-111111111111")).toBe("11111111-1111-1111-1111-111111111111");
    expect(uuid("AABBCCDD-1234-4567-89AB-CDEF01234567")).toBe("aabbccdd-1234-4567-89ab-cdef01234567");
  });

  it("rejects anything that isn't one", () => {
    expect(uuid("not-a-uuid")).toBeUndefined();
    expect(uuid("<your-project-id>")).toBeUndefined(); // unsubstituted placeholder
    expect(uuid("11111111-1111-1111-1111-11111111111")).toBeUndefined(); // one short
    expect(uuid("")).toBeUndefined();
  });
});

describe("bool / resolveBool", () => {
  it("reads the affirmative and negative spellings", () => {
    for (const t of ["true", "TRUE", "1", "yes", "on", true]) expect(bool(t)).toBe(true);
    for (const f of ["false", "0", "no", "off", false]) expect(bool(f)).toBe(false);
  });

  it("reads an unrecognised value as unset, NOT as false", () => {
    // Critical: returning false here would let a garbage runtime value silently override a
    // build-time `true` and switch a feature off.
    expect(bool("maybe")).toBeUndefined();
    expect(bool("")).toBeUndefined();
    expect(bool(undefined)).toBeUndefined();
    expect(resolveBool("maybe", "true")).toBe(true);
  });

  it("takes the first explicit boolean, and an explicit false beats a later true", () => {
    expect(resolveBool(undefined, "true")).toBe(true);
    expect(resolveBool("false", "true")).toBe(false);
    expect(resolveBool(undefined, undefined)).toBeUndefined();
  });
});

describe("runtimeConfig", () => {
  it("reads a key off the injected payload", () => {
    expect(runtimeConfig("publicAppUrl", { __AGORA_CONFIG__: { publicAppUrl: "https://agora.example/" } }))
      .toBe("https://agora.example/");
  });

  it("is undefined when /config.js never loaded, is empty, or lacks the key", () => {
    expect(runtimeConfig("publicAppUrl", undefined)).toBeUndefined();
    expect(runtimeConfig("publicAppUrl", {})).toBeUndefined();
    expect(runtimeConfig("publicAppUrl", { __AGORA_CONFIG__: {} })).toBeUndefined();
    // An unsubstituted / blanked-out placeholder must NOT win over the build-time default.
    expect(runtimeConfig("publicAppUrl", { __AGORA_CONFIG__: { publicAppUrl: "" } })).toBeUndefined();
  });
});
