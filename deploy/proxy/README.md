# Front door (Caddy) — TLS + SPA + service routing

The `proxy` service in the repo-root `docker-compose.yml` is a [Caddy](https://caddyserver.com) front
door — the **single public entrypoint** for the whole stack. It:

- terminates TLS with **automatic HTTPS** (Let's Encrypt, auto-renewed; internal CA for `localhost`),
- adds HSTS + security headers, a request-body cap, and an authoritative `X-Forwarded-For`,
- **serves the admin SPA** static build (baked into the image), and
- **routes every service**: `/v7` + `/socket.io` → agora, `/v7/:projectId/secure-chat/*` +
  `/secure-socket/` → secure-chat, `/moderator` → scorer-worker, `/media` → minio.

It replaces the old admin nginx (which did the SPA + routing) — so there is now **one proxy hop**, not
two. The routing + SPA-serving config lives in the shared snippet
[`agora-routes.caddy`](./agora-routes.caddy), imported by both Caddyfile variants.

It rides the data-plane profiles (`supabase`/`selfhost`) — it's up whenever the API is (it's how the SPA is served, so it's not optional):

```
client ──HTTPS:443──▶ proxy (Caddy: TLS + SPA + router) ──▶ agora / secure-chat / scorer-worker / minio
```

## Run it

```bash
# in .env:
SERVER_NAME=agora.example.com      # your real domain (drives cert issuance)
RATE_LIMIT_TRUSTED_HOPS=1          # one proxy in front of the api (just Caddy)
# MAX_BODY_SIZE=25MB               # optional; default 25MB

docker compose --profile supabase up --build
```

- Point your domain's **DNS at this host** and make sure ports **80 and 443 are publicly reachable** —
  Caddy serves the ACME HTTP-01 challenge on `:80` and the site on `:443`. Caddy provisions the cert on
  first request and renews it automatically.
- Certs + the ACME account persist in the **`caddy-data` volume**, so restarts don't re-issue (which
  would burn Let's Encrypt rate limits).
- Firewall the now-internal host ports (`4000`, `4001`) so traffic only enters via the proxy.

## Local / dev

With the default `SERVER_NAME=localhost`, Caddy uses its **own internal CA** — `https://localhost` works
with no setup. Use `curl -k`, or run `caddy trust` to add the local CA to your trust store.

## Plain HTTP / behind an external TLS terminator

If something else already terminates TLS (a CDN, a cloud LB, an ingress controller), set
`SERVER_NAME=:80` so Caddy serves **plain HTTP** and skips ACME entirely. Caddy is still the SPA server
+ router; it just doesn't do certs. (This replaces the old "bare admin nginx on `:8080`" mode.) Keep
`RATE_LIMIT_TRUSTED_HOPS` matched to the number of proxies in front of the app (2 if the external
terminator chains in front of Caddy).

## Onion / static-cert mode

Tor hidden services (and any deploy where Let's Encrypt can't reach you) need a **cert supplied at
startup** instead of auto-ACME — Let's Encrypt has no way to issue for a `.onion`. A second Caddyfile,
[`Caddyfile.onion`](./Caddyfile.onion), serves a cert you mount in (`tls /certs/site.pem /certs/site.key`)
and never attempts ACME. It imports the same [`agora-routes.caddy`](./agora-routes.caddy) snippet, so the
routing is identical — only the TLS source differs. You select it with the `CADDYFILE` env var, no new
compose service:

```bash
# in .env:
SERVER_NAME=youraddress.onion                  # the hidden-service address
CADDYFILE=./deploy/proxy/Caddyfile.onion        # swap the auto-ACME file for the static-cert one
CADDY_CERTS_DIR=./deploy/proxy/certs            # optional; this is the default
RATE_LIMIT_TRUSTED_HOPS=1

# place your cert + key (these are gitignored — never commit private keys):
cp your-chain.pem   deploy/proxy/certs/site.pem
cp your-key.pem     deploy/proxy/certs/site.key

docker compose --profile supabase up --build
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
- **Per-service upstreams** default to the compose service names (`agora:4000`, `secure-chat:4002`,
  `scorer-worker:4001`, `minio:9000`); override via `API_UPSTREAM` / `SECURE_CHAT_UPSTREAM` /
  `MODERATOR_UPSTREAM` / `MINIO_UPSTREAM` on the `proxy` service. Absent upstreams (secure-chat without
  `--profile secure-chat`, minio without `--profile selfhost`) simply 502 their routes — Caddy resolves
  upstream DNS per request, so a missing service never crashes the front door.
- **Content-Security-Policy:** a strict CSP is SPA-specific — a commented starting point is in the
  `header { … }` block of [`agora-routes.caddy`](./agora-routes.caddy); tune it to your build and uncomment.

## Why Caddy (not nginx)

Caddy does **native, automatic ACME** — stock nginx has no built-in ACME client (it needs a
certbot/acme.sh sidecar + a renewal/reload hook), whereas Caddy provisions and renews certs itself with
zero cert files to manage. Folding the SPA-serving + routing into Caddy means one front door, one routing
surface, and one TLS story instead of an nginx-plus-Caddy two-layer chain.
```
