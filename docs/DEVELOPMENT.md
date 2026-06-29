# Developing Agora

This is the one-stop guide to **developing, debugging, researching, and testing** Agora. It
consolidates what used to be scattered across `CONTRIBUTING.md`, `apps/api/README.md`, and
`docs/CHEAT-SHEET.md`, and folds in the local-dev and diagnostics tooling.

> New to the codebase? Read this top-to-bottom once. Coming back for a command? Jump to the
> [Quick reference](#quick-reference).

The repo-root [`CLAUDE.md`](../CLAUDE.md) is the densest single description of the architecture,
engineering principles (security-first, the testing bar, the log-level policy), and handler
conventions — read it alongside this guide; where the two differ, `CLAUDE.md` is authoritative.

---

## 1. Set up your environment

**Prerequisites:** **Node 22**, **corepack** (ships with Node — activates the pinned `pnpm@10.14.0`),
and a **Supabase project** (free tier is fine) for `DATABASE_URL` *unless* you go fully self-hosted
(option B/C below).

```bash
corepack enable          # activate the pinned pnpm
pnpm install             # install all workspaces, from the repo root
pnpm -r build            # build every package — contract FIRST, topologically
```

> ⚠️ `@agora/api` consumes `@agora-server/contract`'s built `dist/`. From a clean checkout, run
> `pnpm --filter @agora-server/contract build` (or `pnpm -r build`) **before** typechecking the API,
> or imports won't resolve.

Then configure the API's env (each app loads **its own** `.env` from its package dir):

```bash
cd apps/api
cp .env.example .env      # fill in DATABASE_URL (the only hard requirement) — see Configuration below
```

Only `DATABASE_URL` is strictly required; everything else gates a feature and is validated as optional
(empty strings = unset). The repo-root `.env.example` is the comprehensive reference; per-app
`*.env.example` files are minimal subsets. (Want one file across apps? Symlink each app's `.env` to a
root `.env` — `ln -sf ../../.env apps/api/.env`; gitignored, local convenience.)

> 🔒 **Secrets:** never print `.env` secrets. To check a var, `grep` to it and report status/length
> only.

---

## 2. Three ways to run Agora locally

Pick the loop that fits what you're doing. **(A)** is the fastest inner loop; **(C)** is the most
production-shaped while keeping HMR on the code you edit.

### A) All-host — `pnpm dev` against cloud Supabase (fastest loop)

Everything runs on the host; the data plane is your Supabase project. Best for day-to-day API/admin work.

```bash
cd apps/api && pnpm db:migrate:run     # apply migrations (see the gotcha below)
pnpm dev                               # tsx watch → http://localhost:4000/v7  (GET /health to verify)

# in another terminal — the admin SPA
pnpm --filter @agora/admin dev         # vite → http://localhost:5173 (proxies /v7 → :4000)
```

> ⚠️ **Use `pnpm db:migrate:run`, not `pnpm db:migrate`.** drizzle-kit's journal schema is
> misconfigured; `db:migrate:run` is the runtime migrator the container also uses (journal lives in
> the `drizzle` schema). This is the single most common migration foot-gun.

The secure-chat process is separate when you need it: `pnpm --filter @agora/secure-chat dev` (→ `:4002`).

### B) Everything in containers — `docker-compose.yml`

The full deploy shape, built from source. A bare `up` starts **nothing** — you compose two profile
axes (see [`CLAUDE.md` → Monorepo](../CLAUDE.md) and [`docs/CHEAT-SHEET.md`](CHEAT-SHEET.md)):

```bash
# Axis 1 (pick ONE data plane): --profile supabase | --profile selfhost
# Axis 2 (optional add-ons): --profile scorer | secure-chat | scale | full | demo | observability
docker compose --profile selfhost up --build              # API, fully self-contained
docker compose --profile full --profile supabase up --build   # everything, Supabase-backed
```

Use this to verify the containerized topology (Caddy front door, cron, scorer) — not for a tight edit
loop (every change is a rebuild).

### C) Hybrid — backing containers + your code on the host (`docker-compose.dev.yml`)

The best of both: the **supporting containers** (Caddy front door, cron, the Python scorer + model
servers, Postgres/MinIO/Redis/Neo4j) run in Docker, while the **three surfaces you actually edit**
(`agora` API, `secure-chat`, the admin SPA) run as host `pnpm dev` with full HMR. The containers are
repointed at your host code via `host.docker.internal`, and the Caddy front door reverse-proxies the
admin root to your vite server — so `http://localhost/` is the live admin, same-origin with `/v7`.

```bash
# terminal 1 — supporting containers (same profile vocabulary as compose/.prod)
docker compose -f docker-compose.dev.yml --profile selfhost --profile full up --build

# terminals 2–4 — your dev code
pnpm --filter @agora/api dev           # :4000
pnpm --filter @agora/secure-chat dev   # :4002
pnpm --filter @agora/admin dev         # :5173  → reach it through the front door at http://localhost/
```

Host `.env` points at `localhost` for the backing services
(`DATABASE_URL=…@localhost:5432`, `REDIS_URL=redis://localhost:6379`,
`NEO4J_URI=bolt://localhost:7687`, `S3_ENDPOINT=http://localhost:9000`). The one container that *also*
needs the DB (`scorer-worker`) reaches the API + Neo4j at fixed in-network addresses
(`host.docker.internal:4000`, `neo4j:7687`) and uses the standard `DATABASE_URL` — on the `supabase`
data plane the cloud URL works from the container as-is, so there's nothing to set. The one mismatch is
`selfhost`, where the host `DATABASE_URL` is `localhost:5432` (which inside a container is the container
itself): set `DEV_DATABASE_URL=…@db:5432/postgres` and the worker uses that instead (mirrors
`TEST_DATABASE_URL`; falls back to `DATABASE_URL` when unset). Full details are in the header of
[`docker-compose.dev.yml`](../docker-compose.dev.yml).

---

## 3. Seed data

Two layers, run in order. The first is pure SQL; the second drives the **running API** over HTTP as
the seeded admin.

```bash
cd apps/api

# 1. tenant/project row + trigger/RPC validation (asserts loudly on failure)
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seeds/seed.sql

# 2. admin login + (optional) demo content — server must be running
pnpm seed
```

`pnpm seed` orchestrates `scripts/seeds/*.mjs` in order: `00-seed-auth-admin` (prompts **once** for
email + password → seeds the project's configured `auth_provider` backend; press Enter for the demo
default `agora-admin@gmail.com` / `DemoPass123!`) → `01-confirm-demo-data` (a **gate** — answer "no"
and it stops cleanly) → the demo content seeders. Re-running is safe (idempotent), **except** the graph
world (`pnpm seed:graph` / `03-seed-engine.mjs`) which is not — wipe first.

Non-interactive (CI): `ADMIN_EMAIL=… ADMIN_PASSWORD=… SEED_DEMO_DATA=1 pnpm seed`.

The project id for the seeded tenant is `11111111-1111-1111-1111-111111111111`.

---

## 4. Develop — the loop

**The contract is the constraint.** Agora exists so the forked Replyke SDK's typed hooks work
**unchanged**. Before changing any request/response shape, REST path, or socket event, confirm it
against [`docs/MANIFEST.md`](MANIFEST.md) (paths, events, envelopes) and [`docs/MODELS.md`](MODELS.md)
(field shapes), and update them in the same change. Shared types + zod schemas live in
`packages/contract` — never redefine a contract type locally. A change that breaks the SDK's hooks is a
regression, not a feature.

A productive loop:

1. **Design before you build.** For anything non-trivial, sketch the approach first — the endpoints,
   the gates, the shape changes — before touching code.
2. **Scope the change.** Find the call sites and the gates involved (e.g. "where does space-access
   gating happen?", "every call site of `shapeEntity`") so you wire the full set, not a subset.
3. **Implement to the handler conventions** (`CLAUDE.md`): static routes above `/:id`,
   `paginate()`/`readPagination()` envelopes, `Errors.*` (never bare strings), `lib/shape.ts` shapers,
   zod `parseBody()`, and — critically — **every gate on every new path** (`requireAuth`, ownership,
   `lib/space-access.ts` read/post, `removedPolicy(c)` moderation visibility).
4. **Touch the schema?** Edit `apps/api/src/db/schema/*.ts` → `pnpm db:generate` → `pnpm
   db:migrate:run`. Anything Drizzle can't express (triggers, RPC, RLS, PostGIS) is a **hand-written,
   idempotent** custom migration in `apps/api/drizzle/` (`create or replace`, `drop … if exists`). A
   brand-new table must ship its own RLS deny-all. Don't squash existing migrations.
5. **Gate before "done."** `CLAUDE.md` makes this a hard requirement:

   ```bash
   pnpm -r typecheck     # or: pnpm --filter @agora/api typecheck
   pnpm test             # unit suite
   ```

6. **Keep the changelog current.** Any change to behavior, the contract, schema/migrations,
   deployment, or tooling gets a `## [Unreleased]` entry in [`CHANGELOG.md`](../CHANGELOG.md) (Keep a
   Changelog sections). Pure internal refactors don't need one.

`apps/api/src/routes/entities.ts` is the reference for a fully-built domain router — mirror it.

---

## 5. Debug

### Logs

Agora logs through the shared `logger` (`lib/logger.ts`, Pino via wonder-logger) — never `console.*`.
Tune verbosity with env:

```bash
LOG_LEVEL=debug    # trace|debug|info|warn|error|fatal|silent — debug carries the raw error/context
LOG_CONSOLE=aligned   # aligned (dev, colorized) | json (prod)
```

Remember the **level policy**: `info`/`error` are message-only (they ship to aggregators, so no raw
errors/PII); the full `{ err, … }` object lives on `debug`, which is off in production. When a path
fails, the pattern is `logger.error("creating entity failed")` **plus** `logger.debug({ err },
"creating entity failed")`. For a deeper repro, add a temporary `logger.debug({ … })` on the path, run
it, read it back, then remove it.

### Hit an authed route by hand

Mint a test JWT (HS256 over `ACCESS_TOKEN_SECRET`, `sub` = the user's UUID):

```bash
SECRET=$(grep -E '^ACCESS_TOKEN_SECRET=' .env | cut -d= -f2-)
TOK=$(SECRET="$SECRET" node --input-type=module -e 'import {SignJWT} from "jose"; \
  process.stdout.write(await new SignJWT({role:"visitor"}).setProtectedHeader({alg:"HS256"}) \
  .setSubject("<USER_UUID>").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SECRET)))')
curl -s localhost:4000/v7/<projectId>/... -H "Authorization: Bearer $TOK"
```

> ⚠️ Don't load the secret via `dotenv` inside `$(...)` — its stdout banner corrupts the value
> (invalid HTTP header → 400 before Hono). `grep` it, as above.

### Secure-chat: correlate the two log streams

When secure chat misbehaves, the **client SDK** console and the **API server** logs name the same
operation with *different* identifiers and the client emits no timestamps — so they can't be eyeballed
into alignment. Use the correlator:

```bash
cd apps/secure-chat
LOG_LEVEL=trace pnpm dev 2>&1 | tee /tmp/agora-api.log     # capture the server stream, then reproduce
# paste the browser console (Verbose on) into client.log, then:
node ../api/scripts/diag/secure-chat-log-normalize.mjs client.log /tmp/agora-api.log   # human report
node ../api/scripts/diag/secure-chat-log-normalize.mjs --ndjson client.log /tmp/agora-api.log   # raw events
```

It answers what hand-reading can't: device-row id overlap (is this even one run?), op reachability
(did every client request reach the server?), realtime health, and stale-cursor flags. See
[`docs/SECURE-CHAT-DIAG-HARNESS.md`](SECURE-CHAT-DIAG-HARNESS.md).

---

## 6. Research the codebase

Agora is large; the docs are the map. Point yourself at:

- **[`docs/MANIFEST.md`](MANIFEST.md)** — the API contract: every endpoint, socket event, envelope.
- **[`docs/MODELS.md`](MODELS.md)** — field-level response shapes.
- **Subsystem deep-dives** — [`SECURITY.md`](SECURITY.md) · [`SCORER.md`](SCORER.md) ·
  [`SOCIAL-GRAPH.md`](SOCIAL-GRAPH.md) · [`SECURE_CHAT.md`](SECURE_CHAT.md) ·
  [`TELEMETRY.md`](TELEMETRY.md) · [`SELF-HOSTING.md`](SELF-HOSTING.md) · [`REDIS.md`](REDIS.md) ·
  [`STEWARDSHIP.md`](STEWARDSHIP.md) · [`AGORA-SOCIAL.md`](AGORA-SOCIAL.md) ·
  [`AGORA-CORP.md`](AGORA-CORP.md).
- **The reference router** — `apps/api/src/routes/entities.ts` is the fully-built example domain.

**The ecosystem.** Agora is three repos: this one (server + admin), `../agora-sdk` (the forked Replyke
SDK), and `../agora-demo` (the 1:1 compatibility harness). A server change that *requires* an SDK
change usually means the contract shifted — stop and reconsider. The demo is an arms-length consumer
that catches server↔SDK drift; run all three together to verify a contract change end-to-end (see
[`CLAUDE.md` → Ecosystem](../CLAUDE.md)).

---

## 7. Test

[Vitest](https://vitest.dev), **two tiers** (see [`CLAUDE.md` → Engineering principles](../CLAUDE.md)):

- **Unit** (`src/**/*.test.ts`) — pure/branching logic, **no DB**: policy matrices, guards, shapers,
  ranking, validation, envelopes. The harness feeds dummy `DATABASE_URL`/`ACCESS_TOKEN_SECRET` so
  importing `lib/db` never touches a real DB. Mirror `lib/steward-notify.test.ts` or
  `lib/mediation.test.ts`.
- **Integration** (`test/integration/**`) — real **dedicated** cloud Postgres via `TEST_DATABASE_URL`
  (never your dev DB), driving the app in-process with `app.request()` (plus a booted socket.io
  server for chat realtime). Isolation is **by `project_id`**: each test mints its own project + users
  and cascade-cleans. The env forces `VOYAGE_API_KEY`/`ANTHROPIC_API_KEY` empty so embed/LLM paths are
  hermetic no-ops.

```bash
cd apps/api
pnpm test                 # unit (no DB)
pnpm test -- shape        # single file/pattern (vitest name filter)
pnpm test:cov             # unit + v8 coverage
pnpm test:integration     # integration (set TEST_DATABASE_URL first)
```

**What deserves a test** (non-negotiable per `CLAUDE.md`): pure/branching logic ships with a unit test
in the same change; cross-cutting/DB-backed behavior (handlers, permission gates, RPC visibility) gets
an integration test. **Security-relevant logic is the highest priority — assert the *negative* cases**
too: the unauthorized caller is blocked, the removed row is hidden, the other party's id never leaks.
For a bug fix, add the regression test first (red), then fix (green).

**Gotchas:**

- **Integration name filter doesn't work the obvious way.** `pnpm test:integration -- <name>` runs
  the **whole** suite (the `--` is swallowed). To filter:
  `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <name>`.
- **`ENOSPC` mid-run.** A full integration run can exhaust the small macOS `/private/tmp` volume.
  Redirect temp: `mkdir -p "$HOME/.cache/agora-tmp"` once, then prefix with
  `TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration`.

---

## 8. Commit & PR

- **Branch off `root`** (the default branch); keep each PR to one logical change.
- **Conventional Commits with an emoji prefix**, matching history:
  `✨ feat(api): …` · `🐛 fix(admin): …` · `📝 docs: …` · `♻️ refactor(api): …` · `🧪 test(api): …` ·
  `🔒 security(api): …`. Imperative subject under ~72 chars; explain the *why* in the body.
- **Sign off every commit** (`git commit -s`) — DCO, no CLA. CI checks it.
- Before opening: `pnpm -r typecheck` **and** `pnpm test` pass; `CHANGELOG.md` updated;
  `docs/MANIFEST.md`/`docs/MODELS.md` updated if the contract changed.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full contributor policy (licensing, the DCO text,
the wiki workflow).

---

## Quick reference

```bash
# Setup
corepack enable && pnpm install && pnpm -r build

# Run (pick one)
cd apps/api && pnpm dev                                            # A) all-host, cloud Supabase
docker compose --profile selfhost up --build                      # B) all containers
docker compose -f docker-compose.dev.yml --profile selfhost --profile full up --build  # C) hybrid + host code

# Migrate (USE :run)
pnpm db:generate && pnpm db:migrate:run

# Seed
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); psql "$url" -v ON_ERROR_STOP=1 -f scripts/seeds/seed.sql
pnpm seed

# The gate (before "done")
pnpm -r typecheck
pnpm test

# Tests
pnpm test -- <pattern>                                                            # unit, filtered
pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <name>   # integration, filtered
TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration                            # avoid /tmp ENOSPC
```

---

*Keep this doc current when the dev loop, tooling, or test setup changes — same bar as `CHANGELOG.md`.*
