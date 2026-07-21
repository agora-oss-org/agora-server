#!/bin/sh
# Front-door entrypoint: materialize the admin SPA's runtime config, then hand off to Caddy.
#
# WHY: the admin is a static Vite build baked into this image, so every VITE_* var was inlined at
# BUILD time — a deployment that PULLS agora-proxy (docker-compose.prod.yml) can't change them. Values
# that must be per-deployment are read by the SPA from /config.js instead (apps/admin/src/lib/
# runtime-config.ts), which we rewrite here from the container env on every start. Unset vars are
# simply omitted, so the SPA falls back to its build-time defaults.
set -eu

CONFIG_JS="${AGORA_CONFIG_JS:-/srv/config.js}"

# Escape a value for embedding in a double-quoted JS string literal: backslashes and quotes get
# escaped, and any CR/LF is stripped (a newline would terminate the literal and break the bundle).
js_escape() {
  printf '%s' "$1" | tr -d '\r\n' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# emit <js-key> <value> — appends `key: "value",` for a non-empty value, otherwise nothing.
emit() {
  [ -n "${2:-}" ] || return 0
  printf '  %s: "%s",\n' "$1" "$(js_escape "$2")" >>"$CONFIG_JS"
}

if [ -w "$(dirname "$CONFIG_JS")" ]; then
  cat >"$CONFIG_JS" <<'EOF'
// Generated at container start by deploy/proxy/docker-entrypoint.sh — do not edit.
window.__AGORA_CONFIG__ = {
EOF
  # env var                              → /config.js key read by apps/admin/src/config.ts.
  # Each is optional: unset → omitted → the SPA keeps its build-time VITE_* value / built-in default.
  emit publicAppUrl        "${AGORA_PUBLIC_APP_URL:-}"        # public consumer app, for deep links
  emit apiBaseUrl          "${AGORA_ADMIN_API_BASE_URL:-}"    # default /v7 (same-origin via this proxy)
  emit moderatorBaseUrl    "${AGORA_ADMIN_MODERATOR_BASE_URL:-}" # default /moderator (same-origin)
  emit projectId           "${AGORA_ADMIN_PROJECT_ID:-}"      # which project this admin manages
  emit socialGraphEnabled  "${AGORA_ADMIN_SOCIAL_GRAPH_ENABLED:-}" # show Social tab (needs NEO4J_URI)
  emit settingsReadOnly    "${AGORA_ADMIN_SETTINGS_READ_ONLY:-}"   # UI-only guard; see the note below
  # ⚠️ PUBLIC BY CONSTRUCTION: /config.js is served to every visitor, so these credentials are readable
  # by anyone who loads the admin. That is inherent to a browser-side login prefill (they were equally
  # public inlined in the bundle). Only ever point them at an account you mean to publish — the shared
  # demo login the server restricts via OPERATOR_RO_EMAILS — never a real operator account.
  emit demoEmail           "${AGORA_ADMIN_DEMO_EMAIL:-}"
  emit demoPassword        "${AGORA_ADMIN_DEMO_PASSWORD:-}"
  printf '};\n' >>"$CONFIG_JS"
else
  echo "agora-proxy: $(dirname "$CONFIG_JS") is not writable — keeping the baked-in config.js" >&2
fi

exec "$@"
