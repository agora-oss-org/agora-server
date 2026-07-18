# Deployment

Agora ships a root `docker-compose.yml` that builds and wires the whole stack with a **two-axis profile
model**, so a bare `docker compose up` starts nothing — you compose the deploy you want.

> 📋 Start with
> [`docs/CHEAT-SHEET.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/CHEAT-SHEET.md) —
> it maps every deployment recipe to the env vars it needs and where to obtain each value.

## The two axes

**Axis 1 — data plane + API (required, pick exactly one):**

- `--profile supabase` — external Supabase Postgres + Storage.
- `--profile selfhost` — local Postgres + MinIO, fully self-contained. ⚠️ The "local Postgres" here is
  the **`supabase/postgres` image** (the Supabase Postgres *distribution*), not a vanilla Postgres —
  Agora's migrations require its bundled extensions (pgvector, PostGIS, pgmq, pgcrypto) and the
  `anon`/`authenticated`/`service_role` roles + `auth.uid()`. Self-hosting drops the Supabase **cloud**
  (hosted DB / Auth / Storage), not the Supabase Postgres *image*.

Either one brings up the API itself: `agora` (`:4000`), the Caddy front-door `proxy`, and `cron`.

**Axis 2 — optional add-ons (compose freely on top):**

- `--profile scorer` — moderation + social-graph subsystem (scorer ×3 + Neo4j).
- `--profile secure-chat` — the E2E delivery process + Redis.
- `--profile scale` — Redis as the cross-replica rate-limit store.
- `--profile full` — every functional add-on at once (scorer + secure-chat).
- `--profile observability` — the bundled Grafana Alloy → Tempo/Mimir/Loki/Grafana stack (see below).
- `--profile demo` — pulls the [`agora-demo`](https://github.com/jenova-marie/agora-demo) SDK harness and
  serves it behind the front door at `/demo/`, auto-wired to the local API (a one-command evaluator).

```bash
docker compose --profile supabase up --build         # just the API, Supabase-backed
docker compose --profile selfhost up --build         # just the API, self-contained
docker compose --profile full --profile supabase up  # everything, Supabase-backed
docker compose --profile secure-chat up --build      # standalone secure-chat (remote DATABASE_URL, no API)
docker compose --profile selfhost --profile demo up  # API + the SDK demo harness at /demo/
```

## Environment & configuration

Agora ships **one complete env template per compose file** — copy the one that matches how you run it:

| Template | Compose file | Data plane |
|---|---|---|
| `.env.dev.example` | `docker-compose.dev.yml` | host-run app (dev) |
| `.env.selfhost.example` | `docker-compose.yml` | container from source (local Postgres + MinIO) |
| `.env.prod.example` | `docker-compose.prod.yml` | pulled production image |

Each defaults to a **local Postgres + MinIO**, with cloud Supabase as a commented in-file switch. Pick
one and `cp` it to `.env`. The `docker-compose.prod.yml` service definitions **no longer use
`env_file`** — every consumed var is enumerated explicitly (`${VAR:?required}` / `${VAR:-default}`), so
no secret has to live in a `.env` on disk for a prod deploy (values come from the process environment:
shell export / systemd / Swarm / K8s secret injection). Full var-by-var reference:
[`docs/CHEAT-SHEET.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/CHEAT-SHEET.md).

A few deploy-significant knobs beyond the data plane:

- **`CONTENT_DELETE_MODE` (default `hard`)** — out of the box, deleting an entity / comment / chat
  message / event truly `DELETE`s the row (FK cascades take dependents) **and removes its uploaded media
  from storage**. Set `CONTENT_DELETE_MODE=soft` to keep the previous recoverable-tombstone behavior
  (media stays in the bucket). See [[Security]].
- **Native-auth email** — when `DEFAULT_AUTH_PROVIDER=native`, the confirm/reset/resend flows **require
  `AUTH_EMAIL_LINK_ALLOWED_ORIGINS`** (an allowlist of client origins the emailed link may point at) or
  they fail closed with `503 auth/email-not-configured`. A client's `emailRedirectTo` is validated
  against it (open-redirect guard), so a multi-front-end deploy sends each user's link back to the site
  they signed up on. Native transactional email goes out over **Postmark** (`POSTMARK_*`);
  Supabase-backed auth brokers its own emails and is unaffected.
- **Push notifications** — set the `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` trio to
  enable Web Push dispatch (unset → push is a no-op); FCM/APNs providers are credential-gated. See
  [[API & Contract|API-Contract]].
- **Settings-read-only operator** — `SETTINGS_READONLY_EMAILS` (comma-separated emails) marks accounts
  that get the full operator/admin view but a `403 settings/read-only` on the five settings-save
  endpoints. Powers a shared demo login without risking the deployment's own config. Unset = off.

## The front door (Caddy)

The `proxy` service is a **Caddy** front door — the single public entrypoint. It terminates TLS with
**automatic Let's Encrypt** certs (auto-renewed), serves the admin SPA (baked into its image), routes
every service, and adds HSTS + security headers, a body-size cap, and an authoritative
`X-Forwarded-For`. For a real domain set `SERVER_NAME=your.domain` (DNS → this host so ACME can
validate on `:80`) and `RATE_LIMIT_TRUSTED_HOPS=1`.

- ⚠️ **ACME defaults to Let's Encrypt _staging_** (untrusted certs, but safe against prod rate limits
  while you validate DNS/firewall). Set `ACME_CA=https://acme-v02.api.letsencrypt.org/directory` for
  real, browser-trusted certs before going live.
- Plain HTTP behind your own TLS terminator: `SERVER_NAME=:80`.
- Tor / bring-your-own-cert: the `Caddyfile.onion` static-cert variant (via `CADDYFILE`).
- Custom routing / extra site blocks, and overriding the baked config via bind mounts:
  [`deploy/proxy/README.md`](https://github.com/agora-oss-org/agora-server/blob/root/deploy/proxy/README.md).

## Self-hosting (no Supabase)

The `selfhost` data plane runs the *same* server fully self-contained via provider seams — **native**
email/password auth (`DEFAULT_AUTH_PROVIDER=native`) + **S3-compatible** storage (`STORAGE_PROVIDER=s3`
→ MinIO/AWS) + a local Postgres. "No Supabase" means **no Supabase cloud** — the local DB is still the
`supabase/postgres` distribution (required for pgvector/PostGIS/pgmq + the `auth` roles; a vanilla
Postgres won't migrate). See
[`docs/SELF-HOSTING.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/SELF-HOSTING.md).

## Supporting infrastructure

- **Redis** (optional) — the suspension index and a shared rate-limit store; required for some add-ons.
  [`docs/REDIS.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/REDIS.md).
- **Neo4j / DozerDB** (optional) — backs the [[Social Graph]]; setup, plugins, memory tuning, TLS:
  [`docs/DOZERDB.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/DOZERDB.md).

## Observability (optional)

Every service (the API, secure-chat, and the Python scorer) is OpenTelemetry-instrumented — traces,
metrics, and logs with trace↔log correlation. Telemetry is **off by default** (bare deploys stay dark);
`OTEL_SDK_DISABLED=false` is the single on-switch. `--profile observability` brings up a bundled,
self-contained **Grafana Alloy → Tempo / Mimir / Loki / Grafana** stack with the apps' exporters
pre-wired and two Agora dashboards (Overview + Logs) auto-provisioned, or you can point the OTLP/scrape
endpoints at your own collector. Full guide:
[`docs/TELEMETRY.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/TELEMETRY.md).

## Production images

A `docker-compose.prod.yml` pulls pre-built multi-arch images (GHCR + Docker Hub) instead of building
locally. Images are published on version tags by the `docker-publish` workflow. Release/versioning
process: [`docs/RELEASE.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/RELEASE.md).
