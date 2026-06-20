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

## Onion / static-cert mode

Tor hidden services (and any deploy where Let's Encrypt can't reach you) need a **cert supplied at
startup** instead of auto-ACME — Let's Encrypt has no way to issue for a `.onion`. A second Caddyfile,
[`Caddyfile.onion`](./Caddyfile.onion), serves a cert you mount in (`tls /certs/site.pem /certs/site.key`)
and never attempts ACME. You select it with the `CADDYFILE` env var — same `edge` profile, no new compose
service:

```bash
# in .env:
SERVER_NAME=youraddress.onion                  # the hidden-service address
CADDYFILE=./deploy/proxy/Caddyfile.onion        # swap the auto-ACME file for the static-cert one
CADDY_CERTS_DIR=./deploy/proxy/certs            # optional; this is the default
RATE_LIMIT_TRUSTED_HOPS=2

# place your cert + key (these are gitignored — never commit private keys):
cp your-chain.pem   deploy/proxy/certs/site.pem
cp your-key.pem     deploy/proxy/certs/site.key

docker compose --profile full --profile edge up --build
```

Then map the onion's TLS port to Caddy in your `torrc` so `:443` reaches the proxy's TLS listener:

```
HiddenServicePort 443 <caddy-host>:443
```

- **Why a cert at all, if Tor already encrypts?** Tor secures the *transport*, and Tor Browser treats
  `.onion` as a secure context even over plain HTTP — but a real cert gives a secure context in
  **non-Tor** browsers too, which secure-chat's WebCrypto (`crypto.subtle`) requires.
- **Rotation is yours.** With an explicit `tls <cert> <key>`, Caddy uses the files as-is — replace them
  and reload Caddy (`docker compose restart proxy`) when they near expiry. No ACME, no auto-renew.
- A self-signed cert is fine here (Tor authenticates the origin via the `.onion` address itself); use
  `tls internal` in the Caddyfile instead if you'd rather Caddy generate one.

## Optional / advanced

- **ACME expiry-notice email:** set `ACME_EMAIL` in `.env` **and** uncomment `email {$ACME_EMAIL}` in the
  global options block of `deploy/proxy/Caddyfile` (certs issue fine without it; an *empty* `email` arg
  errors, which is why the line stays commented until you opt in).
- **Manual / external certs** (`.onion`, CDN-terminated TLS, corporate PKI, air-gapped): use the
  [`Caddyfile.onion`](./Caddyfile.onion) static-cert variant via `CADDYFILE` — see **Onion / static-cert
  mode** above. It's the general "I bring my own cert" path, not onion-specific.
- **DNS-01 challenge** (wildcards, or when `:80` isn't publicly reachable): use a Caddy DNS-provider
  build + a `tls { dns <provider> <token> }` block. Not wired by default.
- **Content-Security-Policy:** a strict CSP is SPA-specific — a commented starting point is in the
  `Caddyfile` `header { … }` block; tune it to your build and uncomment.

## Why Caddy (not nginx)

The `admin` service is nginx (a static SPA file-server + internal router). The **edge** is Caddy
specifically for **native, automatic ACME** — stock nginx has no built-in ACME client (it needs a
certbot/acme.sh sidecar + a renewal/reload hook), whereas Caddy provisions and renews certs itself with
zero cert files to manage.
