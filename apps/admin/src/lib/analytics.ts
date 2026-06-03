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
