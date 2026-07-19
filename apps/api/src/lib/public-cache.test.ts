import { describe, it, expect } from "vitest";
import { publicCacheControl, PUBLIC_SHARED_MAX_AGE_SECONDS } from "./public-cache.js";

describe("publicCacheControl", () => {
  it("makes success bodies shared-cacheable but always browser-revalidated", () => {
    // max-age=0 is what keeps the takedown window bounded to shared caches: a reader who reloads
    // always reaches the origin and so always sees a removal/un-publish immediately.
    expect(publicCacheControl(200)).toBe(
      `public, max-age=0, s-maxage=${PUBLIC_SHARED_MAX_AGE_SECONDS}, must-revalidate`
    );
  });

  it("caps the shared-cache window at the ratified 300s", () => {
    // Guards the security ratification itself: raising this silently widens the window in which a
    // taken-down post keeps being served from the edge.
    expect(PUBLIC_SHARED_MAX_AGE_SECONDS).toBe(300);
  });

  it("carries the same freshness directives on a 304", () => {
    // A 304 revalidates a stored 200 — emitting no-store here would evict the entry it just
    // confirmed, turning every conditional request into a full refetch.
    expect(publicCacheControl(304)).toBe(publicCacheControl(200));
  });

  it("never caches a 404 — the gate 404s not-yet-published entities", () => {
    // The load-bearing negative: caching this would keep a freshly-published post invisible at the
    // edge for the whole window, so publishing would look broken.
    expect(publicCacheControl(404)).toBe("no-store");
  });

  it("never caches other error statuses", () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      expect(publicCacheControl(status)).toBe("no-store");
    }
  });

  it("treats the whole 2xx range as cacheable", () => {
    for (const status of [200, 201, 204, 299]) {
      expect(publicCacheControl(status)).toContain(`s-maxage=${PUBLIC_SHARED_MAX_AGE_SECONDS}`);
    }
  });

  it("does not cacheable-classify 3xx other than 304", () => {
    // A redirect off this surface is not a body we want held at the edge.
    expect(publicCacheControl(301)).toBe("no-store");
    expect(publicCacheControl(302)).toBe("no-store");
  });
});
