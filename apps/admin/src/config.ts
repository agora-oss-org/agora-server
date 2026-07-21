// Configuration for the admin SPA.
//
// The admin is a STATIC Vite build baked into the agora-proxy image, so `VITE_*` vars are inlined at
// BUILD time — a deployment that PULLS the published image (docker-compose.prod.yml) cannot change
// them. Every setting here is therefore resolved through the `/config.js` RUNTIME seam first (see
// lib/runtime-config.ts; the proxy entrypoint rewrites that file from the container env on each
// start), so a pulled image can be configured without a rebuild.
//
// Precedence is always: runtime `/config.js` → build-time `VITE_*` → the built-in default below.
// Every candidate is type-validated, and an invalid one FALLS THROUGH to the next rather than
// winning — so a typo'd or unsubstituted value degrades to the default instead of breaking the app.
import { baseUrl, httpUrl, resolve, resolveBool, runtimeConfig, uuid } from "./lib/runtime-config";

// Base of the @agora/api server. Same-origin by default: in dev the vite proxy forwards /v7 to :4000,
// in prod the Caddy front door does. Point it at an absolute URL for a cross-origin API (which then
// has to allow CORS).  Runtime key: `apiBaseUrl`.
export const API_BASE =
  resolve(
    baseUrl(runtimeConfig("apiBaseUrl")),
    baseUrl(import.meta.env.VITE_API_BASE_URL),
  ) ?? "/v7";

// Base of the services/scorer service (LLM moderation: the AI-flag queue + per-item analysis).
// Same-origin by default: the dev vite proxy (and the prod front door) forwards /moderator → the
// moderator host, stripping the prefix so it lands on its own /v1/:projectId/moderation/* routes.
// Runtime key: `moderatorBaseUrl`.
export const MODERATOR_BASE =
  resolve(
    baseUrl(runtimeConfig("moderatorBaseUrl")),
    baseUrl(import.meta.env.VITE_MODERATOR_BASE_URL),
  ) ?? "/moderator";

// The project this admin manages. Defaults to the single-project seed UUID (the `projects` row
// genesis/seed.sql creates), so a single-project / self-host deploy needs no config and the login
// form doesn't ask for it. Runtime key: `projectId` — lets one published image serve a different
// project without a rebuild. Must be a uuid; anything else falls through to the seed default.
export const ENV_PROJECT_ID =
  resolve(
    uuid(runtimeConfig("projectId")),
    uuid(import.meta.env.VITE_PROJECT_ID),
  ) ?? "11111111-1111-1111-1111-111111111111";

// Origin of the PUBLIC consumer app (your community's front end — the demo harness locally), used to
// deep-link a moderator/steward from a report, AI flag, or case straight to the reported
// entity/comment (the app reads ?entity=&comment= off its URL). Defaults to the local demo dev server.
// Runtime key: `publicAppUrl` (env `AGORA_PUBLIC_APP_URL`). Validated as an http(s) URL before it can
// win — the value ends up in an <a href>, and bare `new URL()` accepts `javascript:`.
export const PUBLIC_APP_URL =
  resolve(
    httpUrl(runtimeConfig("publicAppUrl")),
    httpUrl(import.meta.env.VITE_PUBLIC_APP_URL),
    httpUrl(import.meta.env.VITE_DEMO_URL), // deprecated — kept so existing builds keep working
  ) ?? "http://localhost:5174/";

// Optional one-click "Log in as admin" button on the login screen — shown only when BOTH are set.
// Point them at the deployment's seeded demo operator account; leave unset and only the ordinary
// sign-in form shows. Runtime keys: `demoEmail` / `demoPassword`.
//
// ⚠️ These are PUBLIC. They ship to every visitor's browser — inlined in the JS bundle when set at
// build time, served verbatim in /config.js when set at runtime. There is no way to give the browser
// a credential without giving it to whoever loads the page. Only ever point them at an account you
// are deliberately publishing (the shared demo login, which the server restricts via
// OPERATOR_RO_EMAILS), NEVER at a real operator account.
export const DEMO_EMAIL = resolve(runtimeConfig("demoEmail"), import.meta.env.VITE_DEMO_EMAIL) ?? "";
export const DEMO_PASSWORD =
  resolve(runtimeConfig("demoPassword"), import.meta.env.VITE_DEMO_PASSWORD) ?? "";

// When true, the Settings page renders view-only: every Save control is disabled and submits are
// blocked client-side. Runtime key: `settingsReadOnly`.
//
// ⚠️ This is a UI guard ONLY — NOT a security boundary, and being runtime-settable does not make it
// one. The API authorizes writes by operator token, so anyone who can call the API directly can still
// save. Real enforcement is the server's OPERATOR_RO_EMAILS allowlist (→ the `settingsReadonly` JWT
// claim → `assertSettingsWritable`); set that too, and treat this purely as the matching UI.
export const SETTINGS_READ_ONLY =
  resolveBool(runtimeConfig("settingsReadOnly"), import.meta.env.VITE_SETTINGS_READ_ONLY) ?? false;

// When true, the Social Graph settings panel, the Social nav entry, and the Community Weather card
// are shown. Default off — enable only on deployments that have NEO4J_URI wired up on the server;
// otherwise the panels render but every graph endpoint returns 503. Runtime key: `socialGraphEnabled`.
export const SOCIAL_GRAPH_ENABLED =
  resolveBool(runtimeConfig("socialGraphEnabled"), import.meta.env.VITE_SOCIAL_GRAPH_ENABLED) ?? false;
