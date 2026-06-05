import { describe, expect, it } from "vitest";
import { isPrivateIp, tryParseLegacyIpv4, assertPublicUrl, safeFetchText, type LookupFn } from "./ssrf.js";

// SSRF guard (lib/ssrf.ts) for the link-preview fetcher. These pin the host/IP classification and the
// manual-redirect loop without touching the network (fetch + DNS are injected). The actual endpoint is
// also covered by test/integration/misc.test.ts.

describe("isPrivateIp", () => {
  it("flags private / loopback / link-local / CGNAT / reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "172.16.0.1", "100.64.0.1", "0.0.0.0", "255.255.255.255"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it("flags loopback / unspecified / ULA / link-local / mapped IPv6", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it("passes genuine public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it("returns false for non-IP strings", () => {
    expect(isPrivateIp("example.com")).toBe(false);
  });
});

describe("tryParseLegacyIpv4", () => {
  it("normalizes decimal / octal / hex / short forms to dotted-quad", () => {
    expect(tryParseLegacyIpv4("2130706433")).toBe("127.0.0.1"); // decimal
    expect(tryParseLegacyIpv4("0x7f.0.0.1")).toBe("127.0.0.1"); // hex first octet
    expect(tryParseLegacyIpv4("0177.0.0.1")).toBe("127.0.0.1"); // octal first octet
    expect(tryParseLegacyIpv4("127.1")).toBe("127.0.0.1");      // 2-part form
  });
  it("returns null for hostnames and normal literal IPs", () => {
    expect(tryParseLegacyIpv4("example.com")).toBeNull();
    expect(tryParseLegacyIpv4("127.0.0.1")).toBeNull(); // already a literal IP (handled elsewhere)
  });
});

describe("assertPublicUrl", () => {
  it("rejects internal hosts, encoded IPs, and non-http schemes with blocked-url", () => {
    for (const url of ["http://localhost/x", "http://127.0.0.1/x", "http://[::1]/x", "http://2130706433/", "http://0x7f.0.0.1/", "https://foo.local/", "ftp://example.com/", "file:///etc/passwd"]) {
      expect(() => assertPublicUrl(url), url).toThrowError(expect.objectContaining({ code: "utils/blocked-url" }));
    }
  });
  it("rejects a malformed URL with bad-url", () => {
    expect(() => assertPublicUrl("not a url")).toThrowError(expect.objectContaining({ code: "utils/bad-url" }));
  });
  it("accepts a public https URL", () => {
    expect(assertPublicUrl("https://example.com/path").hostname).toBe("example.com");
  });
});

// A fetch double: returns a canned Response-like object so the redirect loop is exercised offline.
const fakeRes = (init: { status: number; location?: string; body?: string }) =>
  ({
    status: init.status,
    headers: { get: (k: string) => (k.toLowerCase() === "location" ? init.location ?? null : null) },
    text: async () => init.body ?? "",
  }) as unknown as Response;

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

describe("safeFetchText", () => {
  it("blocks a redirect to an internal host", async () => {
    const fetchImpl = (async () => fakeRes({ status: 302, location: "http://127.0.0.1/admin" })) as unknown as typeof fetch;
    await expect(safeFetchText("https://example.com", {}, { fetchImpl, lookupImpl: publicLookup }))
      .rejects.toMatchObject({ code: "utils/blocked-url" });
  });

  it("blocks a redirect whose host resolves to a private IP", async () => {
    const fetchImpl = (async () => fakeRes({ status: 200, body: "x" })) as unknown as typeof fetch;
    const privLookup: LookupFn = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(safeFetchText("https://sneaky.example", {}, { fetchImpl, lookupImpl: privLookup }))
      .rejects.toMatchObject({ code: "utils/blocked-url" });
  });

  it("gives up after maxRedirects", async () => {
    const fetchImpl = (async () => fakeRes({ status: 302, location: "https://example.com/next" })) as unknown as typeof fetch;
    await expect(safeFetchText("https://example.com", { maxRedirects: 2 }, { fetchImpl, lookupImpl: publicLookup }))
      .rejects.toMatchObject({ code: "utils/fetch-failed" });
  });

  it("follows a redirect to another public host and returns capped html", async () => {
    let hop = 0;
    const fetchImpl = (async () => (hop++ === 0
      ? fakeRes({ status: 301, location: "https://example.org/final" })
      : fakeRes({ status: 200, body: "<title>Hello</title>__padding__" }))) as unknown as typeof fetch;
    const res = await safeFetchText("https://example.com", { maxBytes: 7 }, { fetchImpl, lookupImpl: publicLookup });
    expect(res.url).toContain("example.org");
    expect(res.html).toBe("<title>"); // sliced to maxBytes
  });
});
