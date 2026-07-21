// Runtime configuration seam for the admin SPA — see src/lib/runtime-config.ts.
//
// This file ships as a NO-OP default: with nothing set here, src/config.ts falls back to the
// build-time VITE_* values and then to its hardcoded defaults, which is exactly what `pnpm dev` and a
// plain static deploy want.
//
// In the container, deploy/proxy/docker-entrypoint.sh OVERWRITES this file at start from the
// deployment's env (AGORA_PUBLIC_APP_URL → publicAppUrl), which is how a PULLED agora-proxy image
// gets pointed at a real public site without rebuilding the bundle.
window.__AGORA_CONFIG__ = window.__AGORA_CONFIG__ || {};
