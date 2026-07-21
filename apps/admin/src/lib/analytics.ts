// Browser-side Umami custom-event tracking for the admin app.
//
// This is CLIENT-SIDE ONLY. The browser talks to your Umami instance directly; the @agora/api server
// has no analytics code and never sees these events (that separation is deliberate — `8b72364`
// removed analytics from the API, and only the admin's browser tracking came back).
//
// The tracking <script> used to be injected at BUILD time by vite.config, which made it unreachable
// on a PULLED agora-proxy image. It's now loaded at RUNTIME from the `/config.js` seam
// (lib/runtime-config.ts), so `AGORA_ADMIN_UMAMI_URL=… docker compose up -d proxy` turns analytics on
// with no rebuild. Both values unset → no script, and `track()` degrades to a silent no-op.
import { UMAMI_ID, UMAMI_URL } from "../config";

declare global {
  interface Window {
    umami?: { track: (event: string, data?: Record<string, unknown>) => void };
  }
}

let loaded = false;

/**
 * Inject Umami's tracking script if the deployment configured one. Call once at boot.
 *
 * Umami auto-tracks pageviews including SPA route changes (it patches History), so this is all the
 * wiring pageview analytics needs — `track()` below is only for custom events.
 *
 * Attributes are set via the DOM (not an HTML string), so a hostile config value can't break out into
 * markup. `UMAMI_URL`/`UMAMI_ID` are additionally validated as an http(s) URL / uuid in config.ts, so
 * an unsubstituted `${...}` placeholder or a typo reads as unset rather than emitting a broken tag.
 */
// `null` is accepted (and testable) as "explicitly no document"; omitting the arg falls back to the
// real one, which is itself undefined under SSR. Passing `undefined` would re-trigger this default.
export function initAnalytics(doc: Document | null | undefined = typeof document === "undefined" ? null : document): boolean {
  if (loaded || !doc) return false;
  if (!UMAMI_URL || !UMAMI_ID) return false; // not configured → analytics off
  const el = doc.createElement("script");
  el.defer = true;
  el.src = `${UMAMI_URL}/script.js`;
  el.setAttribute("data-website-id", UMAMI_ID);
  // data-host-url carries the full mount (including any /umami path prefix) so the tracker POSTs to
  // `${UMAMI_URL}/api/send` — the script's src origin alone would drop the prefix.
  el.setAttribute("data-host-url", UMAMI_URL);
  doc.head.appendChild(el);
  loaded = true;
  return true;
}

/** Fire a custom Umami event. Safe to call unconditionally — silently no-ops if tracking is off. */
export function track(event: string, data?: Record<string, unknown>): void {
  const available = typeof window !== "undefined" && !!window.umami;
  // Trace every emit + whether the tracker is loaded. console.debug is the frontend trace level
  // (hidden unless DevTools "Verbose" is on), so it never spams users — but it makes it instantly
  // visible whether an event fired or was dropped because window.umami is absent/blocked.
  console.debug("[umami] track", event, data ?? {}, available ? "→ sent" : "→ dropped (no window.umami)");
  try {
    window.umami?.track(event, data);
  } catch (err) {
    console.debug("[umami] track failed", event, err);
  }
}

/** Test seam: reset the once-only guard so initAnalytics can be exercised repeatedly. */
export function resetAnalyticsForTest(): void {
  loaded = false;
}
