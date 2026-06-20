# Edge proxy (Caddy) — TLS front door

The optional `proxy` service in the repo-root `docker-compose.yml` is a [Caddy](https://caddyserver.com)
edge that becomes the single public entrypoint: **automatic HTTPS** (Let's Encrypt, auto-renewed),
HSTS + security headers, a request-body cap, and an authoritative `X-Forwarded-For`, reverse-proxying to
the `admin` nginx (which serves the SPA and routes `/v7`, `/socket.io`, `/moderator`).

It's **opt-in**, gated behind the `edge` compose profile. It fronts the API stack, so run it alongside
the `full` profile (`--profile full --profile edge`).

```
client ──HTTPS:443──▶ proxy (Caddy) ──HTTP──▶ admin (nginx) ──▶ agora / scorer-worker
```

## Enable it

```bash
# in .env:
SERVER_NAME=agora.example.com      # your real domain (drives cert issuance)
RATE_LIMIT_TRUSTED_HOPS=2          # caddy + admin are the two trusted proxies in front of the api
# MAX_BODY_SIZE=25MB               # optional; default 25MB

docker compose --profile full --profile edge up --build
```

- Point your domain's **DNS at this host** and make sure ports **80 and 443 are publicly reachable** —
  Caddy serves the ACME HTTP-01 challenge on `:80` and the site on `:443`. Caddy provisions the cert on
  first request and renews it automatically.
- Certs + the ACME account persist in the **`caddy-data` volume**, so restarts don't re-issue (which
  would burn Let's Encrypt rate limits).
- Firewall the now-internal host ports (`4000`, `4001`, `8080`) so traffic only enters via the proxy.

## Local / dev

With the default `SERVER_NAME=localhost`, Caddy uses its **own internal CA** — `https://localhost` works
with no setup. Use `curl -k`, or run `caddy trust` to add the local CA to your trust store.

## Optional / advanced

- **ACME expiry-notice email:** add `email you@example.com` to the global options block in
  `deploy/proxy/Caddyfile` (certs issue fine without it).
- **Manual / external certs** (CDN-terminated TLS, corporate PKI, air-gapped): replace the
  `reverse_proxy` site's TLS by adding a [`tls`](https://caddyserver.com/docs/caddyfile/directives/tls)
  directive, e.g. `tls /etc/caddy/certs/cert.pem /etc/caddy/certs/key.pem`, and mount the certs in.
- **DNS-01 challenge** (wildcards, or when `:80` isn't publicly reachable): use a Caddy DNS-provider
  build + a `tls { dns <provider> <token> }` block. Not wired by default.
- **Content-Security-Policy:** a strict CSP is SPA-specific — a commented starting point is in the
  `Caddyfile` `header { … }` block; tune it to your build and uncomment.

## Why Caddy (not nginx)

The `admin` service is nginx (a static SPA file-server + internal router). The **edge** is Caddy
specifically for **native, automatic ACME** — stock nginx has no built-in ACME client (it needs a
certbot/acme.sh sidecar + a renewal/reload hook), whereas Caddy provisions and renews certs itself with
zero cert files to manage.
