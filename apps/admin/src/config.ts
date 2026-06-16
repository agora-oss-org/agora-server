// Runtime configuration sourced from Vite env (VITE_-prefixed vars are the only ones exposed to the
// client). Same-origin by default: in dev the vite proxy forwards /v7 to :4000, in prod nginx does.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/v7").replace(/\/+$/, "");

// Base of the services/scorer service (LLM moderation: the AI-flag queue + per-item analysis).
// Same-origin by default: the dev vite proxy (and prod nginx) forwards /moderator → the moderator
// host, stripping the prefix so it lands on the moderator's own /v7/:projectId/moderation/* routes.
export const MODERATOR_BASE = (import.meta.env.VITE_MODERATOR_BASE_URL ?? "/moderator").replace(/\/+$/, "");

// The project this admin manages. When unset (no single-project default baked in), the login form
// collects it and it's persisted alongside the session.
export const ENV_PROJECT_ID = import.meta.env.VITE_PROJECT_ID || undefined;

// Optional dev convenience: prefill the login form with seeded demo credentials
// (apps/api/scripts/seeds/seed-demo-user.mjs). Leave unset in any real deployment.
export const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL || "";
export const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || "";

// Origin of the consumer/demo app, used to deep-link a moderator from a report straight to the
// reported entity/comment (the demo reads ?entity=&comment= off its URL). Defaults to the local demo
// dev server; set to your deployed app origin in prod.
export const DEMO_URL = import.meta.env.VITE_DEMO_URL || "http://localhost:5174/";

// When VITE_SETTINGS_READ_ONLY=true, the Settings page renders view-only: every Save control is
// disabled and submits are blocked client-side. Lets you deploy the admin for viewing/operation
// without allowing settings changes. NOTE: this is a UI guard only — the API still authorizes writes
// by operator token, so it is NOT a security boundary; lock writes down at the server/token level for
// real enforcement.
export const SETTINGS_READ_ONLY = String(import.meta.env.VITE_SETTINGS_READ_ONLY ?? "").toLowerCase() === "true";

// When VITE_SOCIAL_GRAPH_ENABLED=true, the Social Graph settings panel and Community Weather card
// are shown. Default off — set to "true" only on deployments that have NEO4J_URI wired up on the
// server; otherwise the panel shows but all graph endpoints return 503.
export const SOCIAL_GRAPH_ENABLED = String(import.meta.env.VITE_SOCIAL_GRAPH_ENABLED ?? "").toLowerCase() === "true";
