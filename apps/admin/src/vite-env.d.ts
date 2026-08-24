/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the @agora/api server. Defaults to "/v7" (same-origin: nginx prod proxy / vite dev proxy). */
  readonly VITE_API_BASE_URL?: string;
  /** Project id this admin manages (multi-tenant API addresses /v7/:projectId/...). If unset, the login form asks. */
  readonly VITE_PROJECT_ID?: string;
  /** Dev-only: prefill the login form with seeded demo credentials. Leave unset in real deployments. */
  readonly VITE_DEMO_EMAIL?: string;
  readonly VITE_DEMO_PASSWORD?: string;
  /** When "true", the Settings page is view-only — all Save controls are disabled. UI guard only. */
  readonly VITE_SETTINGS_READ_ONLY?: string;
  /** When "true", the Social Graph settings panel and Community Weather card are shown. Default false.
   *  Set to "true" only on deployments with NEO4J_URI configured on the server. */
  readonly VITE_SOCIAL_GRAPH_ENABLED?: string;
  /** Social sign-in buttons to show on the login screen, e.g. "google,github,apple". Each provider
   *  must also be configured server-side. Unset ⇒ email+password only. */
  readonly VITE_OAUTH_PROVIDERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Admin app version, injected from package.json at build time (see vite.config.ts `define`). */
declare const __APP_VERSION__: string;
