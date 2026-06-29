# Load & Scalability Review

> **Point-in-time assessment — 2026-06-28.** Reviews `@agora/api` + `@agora/secure-chat` +
> `services/scorer` against the question: *can this stand up under significant-to-high load?*
> Findings cite `file:line` so they can be re-verified as the code moves. This is an operational
> review, not a contract change — nothing here is a SECURITY.md regression.

## TL;DR verdict

**Significant load: yes. High load: yes *after* three small fixes; multi-replica high load needs a
few more.** The architecture is fundamentally sound — batched reads, trigger-maintained denorm counts,
fire-and-forget side effects, lazy optional dependencies, a process-level rejection safety net. The
gaps are almost all **operational tuning and missing back-pressure guards**, not structural flaws. The
top three (DB pool ceiling, request timeouts, mandatory Redis at >1 replica) are roughly a day of work
and move the system from "falls off a cliff under stress" to "degrades gracefully."

### Capacity by scenario

| Scenario | Verdict | Gating factor |
|---|---|---|
| 1000s rps, dataset <500k items | ✅ Solid | Batching + capped pagination + precomputed `hot` feed are tight |
| Sustained high rps with untuned pool / no request timeouts | ⚠️ Risky | Untuned connection pool, unbounded in-process caches, no request timeouts |
| Deep pagination / large datasets (>500k items) | ⚠️ Degrades | OFFSET pagination → sequential scans deep in the list |
| 10k+ concurrent socket.io connections | ❌ Needs Redis | In-memory adapter won't fan out across replicas and grows unbounded; secure-chat has **no** adapter |
| Embedding/search-heavy workload | ⚠️ Risky | No fetch timeout on Voyage; no queue-overflow guard on `pending_embeddings` |

---

## ✅ What holds up well

**Database read paths**
- **No N+1s on hot paths.** `lib/shape.ts` batchers (`attachUserReactions:194`, `loadUsers:218`,
  `loadEntityFiles:108`) use `inArray()` and are applied consistently across feed
  (`entities.ts:110-112`), comments (`comments.ts:68-69`), and search (`search.ts:92-109`).
- **Pagination is capped** at 100 items (`http/envelope.ts`), so no runaway result sets.
- **Hot feed is precomputed + index-served** — the `hot` algorithm orders by the stored
  `entities.score` (`lib/ranking.ts:72`) backed by `entities_feed_score_idx` on
  `(projectId, spaceId, score DESC)`. No per-request recompute.
- **Denormalized counts are trigger-maintained** (`reaction_counts`, `replies_count`,
  `members_count`, …) — never recomputed per request.
- **pgvector uses HNSW** (migration `0015`), not the broken IVFFlat default — correct recall from the
  first row, no training step.

**Rate limiting** (`lib/rate-limit.ts`)
- Dual-store: in-process fast path for single replica, Redis Lua-atomic store for multi-replica.
- Spoof-resistant client IP (reads `RATE_LIMIT_TRUSTED_HOPS` from the right of `X-Forwarded-For`).
- Fail-open when Redis is down (request still succeeds); per-IP windows swept every 60s; Redis store
  has LRU eviction (`--maxmemory-policy allkeys-lru`, 128mb).

**Realtime** (`realtime/socket.ts`)
- Redis adapter for cross-replica fan-out when `REDIS_URL` is set (`socket.ts:105-118`), fail-soft to
  in-memory otherwise.
- JWT verified on the socket handshake; scoped to the caller's session; **suspension enforced on connect too**,
  not just on REST (`socket.ts:121-141`).
- All async socket handlers wrapped (`safeOn`) — an unhandled rejection logs, never crashes the server.

**Operational robustness**
- Side effects are fire-and-forget (embeddings, webhooks, notifications) — they don't block the request.
- Optional dependencies (Redis, Neo4j, Supabase) are lazily constructed — **none required at boot**.
- Scorer is correctly decoupled: pull-based pgmq, durable, content creation never blocks on moderation.
- Embeddings fail safe: circuit-breaker + `pending_embeddings` durable queue + paced drain cron — a
  Voyage outage never blocks or silently loses a write (it's queued, and drops *loudly* at the cap).
- Cron is a **singleton container** (supercronic) — no double-execution across API replicas.
- OTel instruments are no-op-safe.

---

## ⚠️ Concerns under high load

Ranked by *what breaks first*. Severity is impact × likelihood at scale.

### 🔴 HIGH — fix before any high-load deployment

#### H1 · No connection-pool ceiling or query timeouts
`packages/core/src/db/index.ts:10` — `postgres(env.DATABASE_URL, { prepare: false })`. **No `max`, no
`idle_timeout`, no `statement_timeout`, no `lock_timeout`.** It silently inherits postgres.js's default
of 10 connections.

This is the scariest item because it's a **cliff, not a slope**. With only 10 connections and no
statement timeout, a single slow query (e.g. a deep OFFSET scan, H2) holds a connection indefinitely
and starves the whole pool fleet-wide — *every* request 503s, not just the slow one. The team clearly
knows the pattern (the migrator uses `max: 1`, the perf seeder `max: 4`) — it just never reached the
runtime client.

> **Fix:** expose `PG_POOL_MAX` / `PG_IDLE_TIMEOUT` / `PG_STATEMENT_TIMEOUT` / `PG_LOCK_TIMEOUT` env
> knobs with sane defaults (e.g. `max: 20–50`, `statement_timeout: 15s`, `lock_timeout: 5s`).
> Size `max` against your pooler's total budget (Supabase transaction pooler ≈ 100 connections shared
> across *all* clients — `max × replicas` must stay under it). **Highest leverage change in the codebase.**

#### H2 · OFFSET pagination everywhere
`http/envelope.ts:8-14` computes `offset = (page-1) * limit`, and every list endpoint uses it — feed
(`entities.ts:46`), comments (`comments.ts:36`), reactions, search. Postgres walks and discards every
skipped row, so page 50 of a million-row feed is a sequential scan **on every request**. Early pages
are fast (masks it in testing); deep pagination is where tail latency explodes — and per H1, a slow
scan holds a scarce connection.

> **Fix:** keyset/cursor pagination on the hot lists — `(score, id)` for feed, `(created_at, id)` for
> comments. Larger change (it touches the response envelope), but the connections module already uses a
> different pagination shape, so there's precedent. Mitigation in the meantime: the 100-item cap and
> H1's `statement_timeout` keep a runaway scan from holding a connection forever.

#### H3 · No request-level timeouts
No `hono/timeout` middleware anywhere (`app.ts`, `middleware/`). A handler can hang indefinitely if a
query stalls or an outbound call (Voyage, webhook, Neo4j) doesn't return. Combined with H1, a handful
of hung requests exhaust the connection pool → cascading failure.

> **Fix:** wrap `/v7/*` in a timeout middleware (`AbortSignal.timeout(30_000)` → 503/504). Pairs with
> H1's `statement_timeout` — the timeout sheds the request, the DB timeout frees the connection.

#### H4 · Unbounded in-process caches
The per-process caches — `social-config` (30s, `social-config.ts:9`), `project-roles` (30s),
`feed-config` (30s), `steward-config` (30s), `webhooks` (30s), `social-weather` (1h) — are bare `Map`s
with **time-based eviction only, no size cap**. Under heavy churn (many distinct cache keys), entries
accrue between sweeps. Correctness is unaffected (DB is the source of truth; roles re-resolve on token
refresh), but memory can grow.

> **Fix:** bound each cache (LRU or max-entries, e.g. 10k entries). Low-effort, removes a slow leak.

### 🟠 MEDIUM — will bite at genuinely high concurrency

#### M1 · Hot-row write contention on denormalized counters
Every reaction fires 2–3 synchronous `UPDATE`s via `on_reaction_change` (`drizzle/0002_triggers.sql:47-73`):
`entities.reaction_counts`, the author's `profiles.reputation`, plus a pgmq enqueue. When a post goes
viral, every reactor serializes on the **same entity row and the same author profile row** — the lock
queue becomes the throughput ceiling for that hot entity *regardless of replica count*. Same pattern for
mass space-joins (`spaces.members_count`) and chat (`conversations.last_message_at`). Inherent to
trigger-maintained denorm counts.

> **Fix (defer until real):** batch/async counter aggregation, or sharded counters. Real redesign —
> only worth it once you actually have viral hotspots. Monitor `pg_locks` / `pg_stat_statements`.

#### M2 · Voyage embed call has no timeout (synchronous search path)
`embeddings.ts:26` — `fetch(VOYAGE_URL, …)` with **no `signal`/`AbortSignal`**. Node's `fetch` has no
default timeout. On the document-indexing path this is fire-and-forget (fine), but **`search.ts:69`
calls `embedText` synchronously** to embed the query, so a stalled Voyage call hangs the search request
until the client gives up — and per H1/H3 holds a connection. (Write-path indexing is protected by the
embed throttle + pending queue; the *read* path is not.)

> **Fix:** `embedText` → `fetch(url, { signal: AbortSignal.timeout(5000) })`, fail fast to a clear 503.

#### M3 · No queue-overflow guard surfaced on `pending_embeddings`
The embed throttle queues to `pending_embeddings` and drains via cron (100/run). There's a pending cap
that drops loudly at the limit (`pending-embeddings.ts`), but a sustained create-spike with
a lagging drain still grows the table. Acceptable today; worth an explicit global ceiling.

> **Fix:** add a total `pending_embeddings` size check; 503 new creates (or skip indexing) past e.g. 50k.

#### M4 · No circuit breaker on Neo4j reads
`routes/social.ts:34-65` maps every Neo4j error to a per-request 503 — there's **no breaker**. If Neo4j
is overloaded, every `/social/*` request still tries the query and waits for the timeout, amplifying
load on a struggling dependency. (Contrast: embeddings *do* have a circuit breaker — good model to
copy.) Weather is 1h-cached, which softens this; Neighborhood is live and unprotected.

> **Fix:** add a circuit breaker (fail fast after N consecutive errors for 60s), mirroring `embed-throttle.ts`.

#### M5 · Missing indexes on hot filter/search columns
- **No `(project_id, moderation_status)` composite** on `entities`/`comments` — the moderation-visibility
  filter rides the hottest read path and isn't index-backed.
- **ILIKE search has no trigram indexes** — `search.ts:178-198` runs `%substring%` on `spaces.name/slug/
  description` and `profiles.name`; none are indexed (only `profiles.username` is). Every space/user
  search is a full scan. (Semantic *content* search is fine — HNSW-backed.)
- Index ordering: `reactions_target_idx` / `reactions_user_idx` don't lead with the `project_id` column.

> **Fix:** `pg_trgm` GIN/GiST indexes on the ILIKE columns; add the `(project_id, moderation_status)`
> composite. Cheap, removes full scans from hot paths.

#### M6 · Query-time feed algorithms can't use an index
Only `hot` uses the precomputed `score`. `decay`/`gravity`/`wilson`/`bayesian` (`lib/ranking.ts:90-132`)
compute per-row expressions → full sort of the candidate set per request. Fine on `hot`; a problem if a
high-traffic project defaults to one of the others.

> **Fix:** prefer stored/snapshotted decay; cap the candidate pool; document these modes as perf-sensitive.

#### M7 · Recompute jobs are full-table sweeps
- `recompute-scores` (every 15 min) is `UPDATE entities SET score = hot_score(...) WHERE deleted_at IS
  NULL` (`drizzle/0012_recompute_scores.sql:9`) — **no time window**, rewrites *every* non-deleted entity
  in the project. At 100k entities that's 100k row updates + WAL + index churn 4×/hour, competing with
  live traffic for the same scarce connections and bloating the table for autovacuum.
- `community-stats` (hourly) re-derives a 25h window + 7-day leaderboards via full GROUP-BY scans
  (`lib/community-stats.ts:36-175`) — cost grows O(n) with content volume.

> **Fix:** scope the recompute to entities with activity since the last run (dirty-set / `updated_at`
> watermark); run these jobs against the direct `:5432` connection, not the shared transaction pooler.

#### M8 · Feed re-rank over-fetch (mitigated, document it)
`entities.ts:96` — `poolSize = Math.min(limit * overFetch, 200)`. **Hard-capped at 200**, default
`overFetch=3`, and **opt-in** (`?rerank=true` + a configured webhook). Low risk as shipped, but worth
documenting `overFetch` as performance-sensitive so an operator doesn't crank it.

> **Fix:** keep the 200 cap; note `overFetch` as perf-sensitive in feed config docs.

### 🟡 LOW / horizontal-scaling hygiene

#### L1 · Redis is a *silent* hard requirement past one replica
Without `REDIS_URL`, scaling beyond one API replica **silently misbehaves** rather than erroring:
- **Rate limiting** becomes per-replica → effective cap is N× configured (documented at `rate-limit.ts:2`),
  and fail-opens if a configured Redis dies.
- **socket.io fan-out** only crosses replicas with the Redis adapter (`socket.ts:105-118`); Caddy has
  **no sticky-session policy** (`agora-routes.caddy:50`), so round-robin guarantees cross-replica chat
  silently drops.
- **secure-chat has no Redis adapter at all** (neither the dep nor the setup in `apps/secure-chat`) — it
  is **single-process-only for realtime**, and that limit is undocumented.

> **Fix:** make `REDIS_URL` a hard, validated requirement (fail closed at boot) when replicas > 1 or for
> >1000 concurrent connections. Add a secure-chat adapter (or document the single-process limit
> prominently). Add the socket.io adapter to `docs/REDIS.md`'s consumer list (currently omitted).

#### L2 · Background sweeps have no overlap guard
`startRateLimitSweep` / `startEmbedThrottleSweep` / `startMetricsFlush` are interval timers with no
"one-at-a-time" flag. Today's sweeps are trivial, but a future heavy sweep could re-fire while the prior
run is in flight. Idempotent, but worth a guard + a duration metric.

#### L3 · SSE stream cleanup
`search.ts:162` uses `streamSSE`. If a client disconnects mid-stream, ensure the handler releases any
held resources. Low risk (one endpoint), but wrap in `try/finally` for hygiene.

#### L4 · No `mem_limit` on the API container
`docker-compose.yml` sets memory limits on the scorer model servers (1.5g) and Redis (128mb) but **not
the API** — an in-memory cache leak (H4) or socket.io growth (L1) has no container backstop.

#### L5 · `prepare: false` re-plan cost
The transaction pooler requires `prepare: false`, so Postgres re-plans every query. Acknowledged in
`apps/api/perf/README.md` (a direct `:5432` connection is faster). Accept it as the pooler trade-off;
revisit only if the planner shows up as a bottleneck under profiling.

#### L6 · Single proxy instance (SPOF)
Caddy is the only public entrypoint (`docker-compose.yml`), 25MB body cap, no explicit upstream
connection/timeout limits. Fine for most deployments; for HA, run it redundant behind an L4 LB.

---

## Prioritized punch list

| # | Fix | Sev | Effort | Why |
|---|-----|-----|--------|-----|
| 1 | DB pool `max` + `statement_timeout`/`lock_timeout`/`idle_timeout` env knobs (H1) | 🔴 | S | Prevents the connection-exhaustion cliff |
| 2 | Request-level timeout middleware on `/v7/*` (H3) | 🔴 | S | Sheds hung requests before they exhaust the pool |
| 3 | Make `REDIS_URL` mandatory (fail-closed) when replicas > 1 (L1) | 🔴 | S | Stops silent rate-limit & chat breakage |
| 4 | `pg_trgm` + `(project_id, moderation_status)` indexes (M5) | 🟠 | S | Removes full scans from hot paths |
| 5 | Bound in-process caches with LRU/max-entries (H4) | 🟠 | S | Removes a slow memory leak |
| 6 | `AbortSignal.timeout` on `embedText` Voyage fetch (M2) | 🟠 | S | Fails search fast instead of hanging |
| 7 | `pending_embeddings` global size guard (M3) | 🟠 | S | Caps table bloat during a Voyage outage |
| 8 | Neo4j circuit breaker (M4) | 🟠 | M | Stops cascading timeouts on a struggling graph |
| 9 | Scope `recompute-scores`/community-stats to dirty rows; run on `:5432` (M7) | 🟠 | M | Kills the 15-min full-table write storm |
| 10 | Keyset pagination on feed + comments (H2) | 🔴 | M/L | Removes the deep-pagination cliff |
| 11 | secure-chat Redis adapter (or document single-process) (L1) | 🟡 | M | Unblocks E2E-chat horizontal scaling |
| 12 | Async/batched denorm counters (M1) | 🟠 | L | Only once viral hot-row contention is real |

**Items 1–6 are ~one day of work** and take the system from "falls over under high load" to "comfortably
handles high load on a vertically-scaled (single-replica) deployment." 7–10 are what true multi-replica
high traffic needs. 11–12 are scale-when-you're-popular work.

## Recommended posture for production-at-scale

1. Set explicit `postgres` pool `max` + statement/lock timeouts (H1).
2. Add per-request timeout middleware, 30s (H3).
3. Bounded LRU caches, max ~10k entries (H4).
4. `pending_embeddings` queue-size guard + Voyage fetch timeout (M2/M3).
5. **Redis mandatory** for any deployment >1 replica or >1000 concurrent connections (L1).
6. Document the Voyage embed timeout and `overFetch` as perf-sensitive config.

With items 1–6 in place, a **3-replica deployment behind Redis is comfortable at 10k+ concurrent users**.
The architecture is well-designed for moderate load; the remaining gaps are operational tuning and
back-pressure guards, not fundamental flaws.

## Method & caveats

Synthesized from a parallel review of the DB connection layer, hot read-path queries, indexes &
trigger write-amplification, caching/rate-limiting/horizontal-scaling, realtime socket.io scaling, and
background jobs/cron/scorer/deploy, cross-checked against an independent second assessment. Code-level
claims were re-verified against source (`file:line`). **Not** load-tested here — the `apps/api/perf/`
k6 harness is the empirical complement; treat the capacity numbers above as reasoned estimates to
validate against it, not measurements.
