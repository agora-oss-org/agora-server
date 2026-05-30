// Runtime configuration sourced from Vite env (VITE_-prefixed vars are the only ones exposed to the
// client). Same-origin by default: in dev the vite proxy forwards /v7 to :4000, in prod nginx does.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/v7").replace(/\/+$/, "");

// The project this admin manages. When unset (no single-project default baked in), the login form
// collects it and it's persisted alongside the session.
export const ENV_PROJECT_ID = import.meta.env.VITE_PROJECT_ID || undefined;

// Optional dev convenience: prefill the login form with seeded demo credentials
// (apps/api/scripts/seed-demo-user.mjs). Leave unset in any real deployment.
export const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL || "";
export const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || "";
