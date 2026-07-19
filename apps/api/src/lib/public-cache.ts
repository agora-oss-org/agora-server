// Shared-cache policy for the anonymous /v7/:projectId/public/* surface.
//
// The internet-public gate (lib/public-access.ts) is re-derived live on every request precisely so
// that a moderation removal, an un-publish, a soft-delete, or a space flipped to members-only
// un-exposes a post immediately. A shared-cache TTL is therefore EXACTLY the window in which a
// taken-down post keeps being served from the edge — it is a deliberate, bounded weakening of the
// "instantly un-exposes" property in the design doc (§3), ratified at 300s.
//
// The split is what keeps that bounded:
//   max-age=0        → private caches (browsers) revalidate every time, so a reader who refreshes
//                      ALWAYS sees current state. A takedown is instant for anyone who reloads.
//   s-maxage=300     → shared caches (CDN/proxy) absorb the embed traffic for at most 5 minutes.
//   must-revalidate  → once stale, a cache MUST reach the origin; it may never serve stale on error.
export const PUBLIC_SHARED_MAX_AGE_SECONDS = 300;

const CACHEABLE = `public, max-age=0, s-maxage=${PUBLIC_SHARED_MAX_AGE_SECONDS}, must-revalidate`;

/**
 * The Cache-Control value for a public-surface response of the given status.
 *
 * Only success bodies are cacheable. A 404 must be `no-store`: the gate 404s a not-yet-published
 * entity, so caching it would keep a freshly-published post invisible at the edge for the whole
 * window — publishing would appear broken. 304 counts as cacheable because it revalidates a stored
 * 200 and must carry that entry's freshness directives forward.
 */
export function publicCacheControl(status: number): string {
  const cacheable = (status >= 200 && status < 300) || status === 304;
  return cacheable ? CACHEABLE : "no-store";
}
