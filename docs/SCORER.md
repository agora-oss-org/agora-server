# `services/scorer` — content scoring & moderation 🧪💞

> **Status: FOUNDATION.** The salvaged pure logic (policy prompts, auto-action, verdict parsing,
> reason formatting) is real and unit-tested. The ML / pgmq / Neo4j / Haiku I/O is structured **stubs**
> (signatures + control-flow skeletons + logged TODOs). This doc describes the target architecture; the
> implementation pass fills the stubs.

`services/scorer` is Agora's content scoring + moderation subsystem. It **replaces `apps/moderator`**
(the Node/Hono LLM-over-webhooks service) with an **async, post-publish** Python pipeline: content
publishes instantly, then — a beat later, off a queue — it is scored by two RoBERTa classifiers,
borderline cases are adjudicated by Claude Haiku, removals are written back through the API, and a
relationship signal is recorded in a graph.

## What this is (and why)

The old moderator blocked on a synchronous webhook → single-LLM call per item. The scorer instead:

- **decouples** scoring from posting via **Supabase pgmq** (a Postgres-native queue) so posting is
  instant and resilient — if the scorer is down, jobs wait safely in the DB and drain when it's back;
- adds a **cheap RoBERTa pre-filter** so the (paid, slower) LLM only sees the *borderline* items;
- adds a **relationship-quality** signal feeding a **Neo4j** graph — a capability the moderator never had;
- **reuses** the moderator's proven brain — the exact policy prompt + `allow/block/review` verdict
  schema, the auto-action thresholds, the `moderation_analyses` audit table, the API write-back, and the
  admin AI-flag queue — so the cutover is behaviour-compatible for operators.

## The three containers

| Container | Role | Port | CPUs | Image |
|---|---|---|---|---|
| `scorer-toxicity` | RoBERTa **toxicity** classifier, model warm in RAM | 8001 | pinned `0,1` | `Dockerfile.model-server` |
| `scorer-relationship` | RoBERTa **relationship-quality** (sentiment) classifier | 8002 | pinned `2,3` | `Dockerfile.model-server` |
| `scorer-worker` | pgmq consumer + cascade + write-back + Neo4j + admin API | 4001 | `4` | `Dockerfile.worker` |

The two model servers are the **same image**, differentiated only by `SCORER_MODEL` / `SCORER_MODEL_KIND`
/ `SCORER_PORT`. They're pinned to **disjoint CPU cores** (compose `cpuset` + `OMP_NUM_THREADS`) so the
worker's parallel calls actually run side-by-side rather than contending. (cpuset values are
host-specific — set them to your box's layout, e.g. a 4-vCPU `c6i.xlarge`.) The worker is a single
process that runs both the admin HTTP server **and** the queue-consumer loop (an asyncio background task).

All three run under `docker-compose.yml` with the rest of Agora; the worker reaches the model servers by
compose DNS (`http://scorer-toxicity:8001`).

## Data flow

```
entity / comment / chat_message  INSERT  (or content-changing UPDATE)
   │  Postgres trigger "Trigger A" → pgmq.send('scorer_jobs', {targetType,targetId,projectId})
   │  (atomic with the write — a job exists only if the row committed)
   ▼
pgmq queue 'scorer_jobs'   (Supabase pgmq; at-least-once, visibility-timeout redelivery)
   ▼
scorer-worker ── poll pgmq.read() ──► per job:
   │   fetch content text by id
   │   asyncio.gather( toxicity:8001/score , relationship:8002/score )   ← parallel
   │   cascade (toxicity score):
   │       < grayzone_low   → allow
   │       ≥ grayzone_high  → block (high confidence)
   │       in between       → escalate to Claude Haiku (salvaged policy prompt + verdict schema)
   │   decide_auto_action(verdict, confidence, thresholds)   ← salvaged pure fn
   │   if removable + triggered → POST {API}/internal/moderation/apply (x-moderation-secret)
   │   upsert moderation_analyses  (idempotent, keyed by target)   ← admin AI-flag queue source
   │   MERGE relationship edge into Neo4j  (idempotent)            ← graph schema OUT OF SCOPE
   │   pgmq.delete(msg_id)
   └── ALSO serves /v1/:projectId/moderation/* (operator JWT) — identical shapes to the old moderator
```

## The pgmq queue + Trigger A

- **Atomic enqueue.** Migration `apps/api/drizzle/0027_scorer_pgmq_enqueue.sql` enables `pgmq`, creates
  the `scorer_jobs` queue, and attaches triggers that `pgmq.send()` a job in the **same transaction** as
  the content write. No lossy webhook hop — the job is committed iff the content is.
- **Full parity, loop-safe.** Triggers fire on `entities`, `comments`, and `chat_messages`, on **INSERT**
  and on **content-changing UPDATE**. INSERT and UPDATE are *separate* triggers, and the UPDATE trigger
  is **gated** (`when old.content is distinct from new.content`, plus `title` for entities) so the
  moderation write-back itself (which only touches `moderation_status`) and trigger-maintained
  count/reaction bumps do **not** re-enqueue. This is what prevents a write-back → re-score loop.
- **At-least-once → idempotency contract.** pgmq redelivers a message if the worker dies before
  `pgmq.delete` (visibility-timeout). So every downstream write MUST be idempotent: the
  `moderation_analyses` upsert is keyed by target, and the Neo4j write is a `MERGE`. A poison message is
  archived after N redeliveries.
- **id-only payload.** Jobs carry only `{targetType, targetId, projectId}`; the worker fetches the text
  (and space/author) by id. Keeps messages small and avoids stale/duplicated content in the queue.

## Why pgmq, not Redis (even though Redis is now in the stack)

Redis was added to Agora for **rate limiting** (shared atomic counters across API replicas — the
in-process limiter in `lib/rate-limit.ts` doesn't hold across processes). That removed the original
"no new infra" argument for pgmq — but the queue **stays on pgmq**, because the two jobs want different
tools:

- **The decisive reason is atomic enqueue.** "Trigger A" calls `pgmq.send()` *inside the same Postgres
  transaction* as the content write, so a job exists iff the row committed. Redis isn't in that
  transaction, so a Redis queue forces one of: app-level `XADD` after the insert (lossy dual-write — the
  exact failure mode pgmq kills), a `pg_net` trigger → Redis (non-transactional, lossy, +extension), or a
  transactional outbox (which is just pgmq rebuilt). None is better than what we have.
- **Durability.** Moderation jobs shouldn't silently vanish; pgmq is ACID-durable by default. Redis
  Streams needs AOF tuning and is still weaker.
- **Latency doesn't matter here.** The pipeline is async/post-publish, so Redis's throughput/latency edge
  (its real strength, and why it's perfect for rate limiting) buys nothing for the queue.
- **Smaller dependency surface.** The worker already needs a Postgres connection (for
  `moderation_analyses`); pgmq adds none. A Redis queue would make it need both.

**So: Redis for rate limiting, pgmq for the scorer queue — right tool per job, not redundancy.** Revisit
only if you decide one queue technology is worth giving up the atomic-enqueue guarantee.

## The cascade

The toxicity RoBERTa runs on **everything** and its score drives a gray-zone gate:

- below `SCORER_GRAYZONE_LOW` → `allow` (record the score, no LLM);
- above `SCORER_GRAYZONE_HIGH` → `block` at high confidence;
- in the band → **escalate to Claude Haiku**, which returns the full `{verdict, categories, confidence,
  reason}` using the **salvaged** `policy.build_system_prompt` + the tolerant `verdict.parse_verdict`.

The verdict then flows through the **salvaged** `auto_action.decide_auto_action` against the project's
two confidence floors (block/review), and — for `entity`/`comment` only (messages always queue) — a
triggered removal is applied via the API write-back. Every assessment records one `moderation_analyses`
row (the admin queue). The **relationship** RoBERTa score is written as a Neo4j edge in parallel.

## Preserved contracts (so the admin keeps working)

- **`moderation_analyses`** table + the **`ModerationAnalysis`** envelope — unchanged from the moderator.
- **`/v1/:projectId/moderation/*`** operator endpoints (config/stats/queue/analysis + analyze/resolve/
  remove) — the `scorer-worker` serves identical shapes; the admin nginx upstream is just repointed
  (`MODERATOR_UPSTREAM → http://scorer-worker:4001`).
- **`POST {API}/internal/moderation/apply`** write-back (`x-moderation-secret`, `moderatedByType=client`)
  — reused verbatim; **no API change needed**.
- **Operator JWT** (HS256 over `ACCESS_TOKEN_SECRET`, `operator` claim) — verified the same way (PyJWT).

## Salvaged from `apps/moderator`

| moderator source | scorer module | kind |
|---|---|---|
| `lib/policy.ts` | `scorer/policy.py` | verbatim (prompts + verdict schema) |
| `lib/auto-action.ts` | `scorer/auto_action.py` | verbatim (pure fn) |
| `lib/llm-provider.ts` `parseVerdict` | `scorer/verdict.py` | port (tolerant parse) |
| `lib/reason.ts` | `scorer/reason.py` | port |
| `lib/project-config.ts` + `lib/env.ts` | `scorer/config.py` | port (jsonb merge over env, 30s cache) |
| `lib/api-client.ts` | `worker/writeback.py` | verbatim contract |
| `middleware/auth.ts` | `scorer/jwt_auth.py` | port (jose → PyJWT) |
| `routes/moderation.ts` | `worker/admin_api.py` | port (Hono → FastAPI, identical shapes) |
| `lib/shape.ts` `shapeAnalysis` | `worker/analyses.py` + `scorer/models.py` | port |
| `lib/assess-and-record.ts` | `worker/pipeline.py` | shape port (now cascade-shaped) |

## Config & feature gates

All via the root `.env` (see `.env.example`). Reused: `DATABASE_URL`, `ACCESS_TOKEN_SECRET`,
`API_BASE_URL`, `MODERATION_SERVICE_SECRET`, `MODERATION_BLOCK/REVIEW_AUTO_ACTION_THRESHOLD`. New:
`SCORER_*` (models, URLs, gray-zone, Haiku, queue/poll) and `NEO4J_*`. Feature gates:

- no `ANTHROPIC_API_KEY` → cascade records the RoBERTa score but never escalates (borderline → human queue);
- no `NEO4J_*` → the relationship-edge write is a logged no-op;
- no `MODERATION_SERVICE_SECRET`/`API_BASE_URL` → write-back disabled; verdicts still persist + queue.

> **Postgres pooler note:** `DATABASE_URL` is the Supabase transaction pooler (`:6543`, `prepare:false`),
> which doesn't support prepared statements — the Python client uses asyncpg with `statement_cache_size=0`.

## Operations

```bash
# Build the three images (from repo root — build context is the root):
docker compose build scorer-toxicity scorer-relationship scorer-worker
docker compose up scorer-toxicity scorer-relationship scorer-worker neo4j

# Apply the enqueue migration (idempotent):
docker compose run --rm agora node scripts/migrate.mjs

# Local pure-fn tests:
cd services/scorer && pip install -r requirements-dev.txt && pytest
```

- **Scaling:** the model servers are stateless — scale horizontally; the worker is a single consumer
  group (add replicas to share the queue once wired).
- **CPU pinning:** set `cpuset` per the deploy host; the parallel model calls only benefit if the two
  servers own disjoint cores.
- **Verify pgmq first:** confirm `create extension if not exists pgmq;` succeeds on your Supabase plan —
  it's the entire transport.
- **Image size:** the real (un-stubbed) model server adds the CPU `torch` wheel, which is large; slimming
  it is later work.

## Roadmap (un-stub, in order)

1. Real RoBERTa load + `/score` (`model_server/classifier.py`).
2. asyncpg pool + content-text fetch + `moderation_analyses` upsert + admin reads (`scorer/db.py`,
   `worker/analyses.py`, `worker/admin_api.py`).
3. pgmq read/delete/archive wiring (`scorer/pgmq.py`, `worker/consumer.py`).
4. Haiku HTTP call (`scorer/haiku.py`) + write-back HTTP (`worker/writeback.py`).
5. Neo4j **graph schema** + edge MERGE (`scorer/neo4j.py`, `worker/neo4j_writer.py`).
6. Retire `apps/moderator` source + clean the dead `webhooks.ts` moderation path.
