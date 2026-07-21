// Configuration for the admin SPA. Most of it is BUILD-time (VITE_-prefixed vars are the only ones
// Vite exposes to the client, and they're inlined into the static bundle). Values that must be
// settable on an already-published image read through the `/config.js` runtime seam instead — see
// lib/runtime-config.ts. Same-origin by default: in dev the vite proxy forwards /v7 to :4000, in prod
// the Caddy front door does.
import { httpUrl, resolve, runtimeConfig } from "./lib/runtime-config";

export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "/v7").replace(/\/+$/, "");

// Base of the services/scorer service (LLM moderation: the AI-flag queue + per-item analysis).
// Same-origin by default: the dev vite proxy (and prod nginx) forwards /moderator → the moderator
// host, stripping the prefix so it lands on the moderator's own /v7/:projectId/moderation/* routes.
export const MODERATOR_BASE = (import.meta.env.VITE_MODERATOR_BASE_URL ?? "/moderator").replace(/\/+$/, "");

// The project this admin manages. Defaults to the single-project seed UUID (the `projects` row
// genesis/seed.sql creates), so a single-project / self-host deploy needs no config and the login form
// doesn't ask for it. Override with VITE_PROJECT_ID to point the build at a different project.
export const ENV_PROJECT_ID = import.meta.env.VITE_PROJECT_ID || "11111111-1111-1111-1111-111111111111";

// Optional dev convenience: prefill the login form with seeded demo credentials
// (apps/api/scripts/seeds/00-seed-auth-admin.mjs). Leave unset in any real deployment.
export const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL || "";
export const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || "";

// Origin of the PUBLIC consumer app (your community's front end — the demo harness locally), used to
// deep-link a moderator/steward from a report, AI flag, or case straight to the reported
// entity/comment (the app reads ?entity=&comment= off its URL). Defaults to the local demo dev server.
//
// This one is RUNTIME-configurable (unlike the build-time flags above): set AGORA_PUBLIC_APP_URL in
// the deployment's .env and the proxy container writes it into /config.js at start, so a PULLED
// agora-proxy image can be pointed at your real site without a rebuild. VITE_PUBLIC_APP_URL still
// works as a build-time default (handy for `pnpm dev`), and the legacy VITE_DEMO_URL is honoured last.
// Each candidate is validated as an http(s) URL before it can win, so a malformed or non-web value
// (an unsubstituted placeholder, a `javascript:` scheme) falls through instead of reaching an href.
export const PUBLIC_APP_URL =
  resolve(
    httpUrl(runtimeConfig("publicAppUrl")),
    httpUrl(import.meta.env.VITE_PUBLIC_APP_URL),
    httpUrl(import.meta.env.VITE_DEMO_URL), // deprecated — kept so existing builds keep working
  ) ?? "http://localhost:5174/";

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
