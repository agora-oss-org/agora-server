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
  # Origin of the public consumer app, used for the admin's "Open in app" deep links.
  emit publicAppUrl "${AGORA_PUBLIC_APP_URL:-}"
  printf '};\n' >>"$CONFIG_JS"
else
  echo "agora-proxy: $(dirname "$CONFIG_JS") is not writable — keeping the baked-in config.js" >&2
fi

exec "$@"
