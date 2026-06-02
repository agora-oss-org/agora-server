// Browser-side Umami custom-event tracking for the admin app. The tracking <script> is injected at
// build time by vite.config (gated on AGORA_UMAMI_URL + AGORA_UMAMI_ADMIN_ID); it auto-tracks
// pageviews. This wrapper adds *custom events* for high-signal admin actions. No-op (and never
// throws) when the script isn't loaded, so the UI is unaffected when analytics is off.
declare global {
  interface Window {
    umami?: { track: (event: string, data?: Record<string, unknown>) => void };
  }
}

/** Fire a custom Umami event. Safe to call unconditionally — silently no-ops if tracking is off. */
export function track(event: string, data?: Record<string, unknown>): void {
  try {
    window.umami?.track(event, data);
  } catch {
    /* analytics must never break the UI */
  }
}
