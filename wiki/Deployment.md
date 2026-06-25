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
- `--profile full` — every optional add-on at once.

```bash
docker compose --profile supabase up --build         # just the API, Supabase-backed
docker compose --profile selfhost up --build         # just the API, self-contained
docker compose --profile full --profile supabase up  # everything, Supabase-backed
docker compose --profile secure-chat up --build      # standalone secure-chat (remote DATABASE_URL, no API)
```

## The front door (Caddy)

The `proxy` service is a **Caddy** front door — the single public entrypoint. It terminates TLS with
**automatic Let's Encrypt** certs (auto-renewed), serves the admin SPA (baked into its image), routes
every service, and adds HSTS + security headers, a body-size cap, and an authoritative
`X-Forwarded-For`. For a real domain set `SERVER_NAME=your.domain` (DNS → this host so ACME can
validate on `:80`) and `RATE_LIMIT_TRUSTED_HOPS=1`.

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

## Production images

A `docker-compose.prod.yml` pulls pre-built multi-arch images (GHCR + Docker Hub) instead of building
locally. Images are published on version tags by the `docker-publish` workflow. Release/versioning
process: [`docs/RELEASE.md`](https://github.com/agora-oss-org/agora-server/blob/root/docs/RELEASE.md).
