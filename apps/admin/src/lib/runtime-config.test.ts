import { describe, it, expect } from "vitest";
import { httpUrl, nonEmpty, resolve, runtimeConfig } from "./runtime-config";

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
