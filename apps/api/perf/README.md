# Agora API load-test harness

A reproducible **baseline** for the REST API so you can see how latency/throughput move as the
codebase changes. The discipline that makes a baseline trustworthy is **variance control**: the only
thing that should differ between two runs is your code. Everything here exists to hold the rest fixed.

## What it does

1. **`seed-perf-data.mjs`** — wipes + rebuilds a dedicated, isolated dataset (its own throwaway
   `project_id`) directly in Postgres: profiles, entities, and multi-level comment threads. Byte-identical
   every run. Mints a pool of HS256 access tokens (sub = profile id — the exact thing `requireAuth`
   verifies; no Supabase Auth user needed). Writes `perf/.fixture.json`.
2. **`scenario.js`** — the k6 workload: a read-heavy social-feed traffic mix against that corpus, every
   request bearing a seeded token (so the authed hot path — token verify + suspension check — is measured).
3. **`run.mjs`** — orchestrates seed → k6 → a timestamped, git-stamped JSON summary under `baselines/`.
4. **`compare.mjs`** — diffs two saved baselines into per-endpoint p95/p99 + throughput deltas.

## Prerequisites

- **k6** (standalone Go binary): `brew install k6` (macOS) or https://grafana.com/docs/k6/latest/set-up/install-k6/
- A **running API** to hit, and `DATABASE_URL` + `ACCESS_TOKEN_SECRET` in `apps/api/.env` pointing at the
  **same** Postgres + secret that API uses.

### Canonical target: the local self-host docker stack (lowest variance)

From the repo root, bring up an isolated, self-contained stack (local Postgres + MinIO, no Supabase):

```bash
docker compose --profile full --profile selfhost up -d --build
```

Point the harness at it: `PERF_BASE_URL` at the API, and `.env`'s `DATABASE_URL` at the same local
Postgres the stack uses. Hitting the API **directly** (`:4000`) measures the API; hitting it through the
admin nginx measures the proxy too — pick one and keep it constant.

> You can also baseline a host-run API (`pnpm build && pnpm start`) against the selfhost DB. **Avoid
> `pnpm dev`** for baselines — `tsx watch` adds interpreter overhead that pollutes the numbers. And never
> baseline the prod-shared Supabase: shared infra = noise, and you'd pollute real data.

## Confounders this harness already neutralizes — and ones you must

Handled here: isolated corpus, identical data each run, warmup discarded, per-endpoint tagging, authed hot path.

You control:
- **Rate limiting** — off locally unless `RATE_LIMIT_MAX` is set (`middleware/rate-limit.ts` short-circuits).
  Leave it unset, or you'll measure the limiter (429s), not the API.
- **External calls** — set `VOYAGE_API_KEY=""` and `ANTHROPIC_API_KEY=""` so entity writes don't include a
  Voyage embed / LLM call you don't control (same hermeticity trick the integration suite uses).
- **DB connection class** — the `:6543` transaction pooler runs `prepare:false` (no prepared statements →
  re-plan per call). A direct `:5432` connection gives *different* (faster) numbers. Pick one; note it in
  the baseline. The selfhost stack's local Postgres is the stable default.
- **The load generator** — keep it off (or consistently co-located with) the box under test.

## Run it

```bash
cd apps/api

pnpm perf:seed                       # (re)seed the fixture only
pnpm perf:baseline                   # seed + run, default 50 VUs / 2m steady → saves a baseline
PERF_VUS=100 PERF_DURATION=3m pnpm perf:baseline
pnpm perf:baseline -- --no-seed      # reuse the existing fixture (skip re-seed)

# or k6 directly (after a seed):
k6 run -e PERF_VUS=50 -e PERF_DURATION=2m perf/scenario.js
```

### Tunables

Seed: `PERF_USERS` (20), `PERF_ENTITIES` (300), `PERF_THREAD_ENTITIES` (30), `PERF_ROOTS_PER_THREAD` (15),
`PERF_REPLIES_PER_THREAD` (20), `PERF_CLIENT_ID`, `PERF_BASE_URL`, `PERF_TOKEN_TTL` (24h).
Run: `PERF_VUS` (50), `PERF_DURATION` (2m), `PERF_WARMUP` (30s).

## The workflow

1. **First run = the baseline.** Thresholds in `scenario.js` ship permissive so it passes; read the
   printed p50/p95/p99 per endpoint.
2. **Tighten thresholds** to ~1.2× the observed p95 and commit `scenario.js` + the baseline JSON. Now the
   same script is a **regression gate**: k6 exits non-zero when an endpoint blows its budget (wire into CI).
3. **After a change**, re-run and `node perf/compare.mjs <old> <new>` — `⚠️` flags a >5% p95 regression.
4. **Find capacity** by ramping `PERF_VUS` (50→100→200…) until p95 degrades or errors climb — that's the
   knee; baseline at a fixed load *below* it.

## What load testing can't tell you (pair it with these)

The load surfaces *what* regressed; to learn *why*:
- **OTel** (`src/instrument.ts`, Prometheus `:9464`, service-level RED) — scrape during the run.
- **Postgres** `pg_stat_statements` + `EXPLAIN ANALYZE` on whatever query the load fingers as the hot spot.

## Scope

REST only for now. socket.io realtime (`/socket.io`, `/secure-socket/`) is persistent-connection load —
a separate, harder problem — and is deliberately deferred.
