# Scorer subsystem — toxicity + relationship scoring (replaces the moderator)

**Date:** 2026-06-05
**Status:** Approved design — foundation scaffolded (ML/pgmq/Neo4j/Haiku I/O are stubs)
**Scope:** `services/scorer` (new), `apps/api/drizzle` (migration `0027`), `docker-compose.yml`,
`.env.example`, `apps/admin` (compose upstream only). Retires `apps/moderator` from compose.

## Problem

`apps/moderator` moderates synchronously over HMAC webhooks → one LLM call per item. We want: (1) **async,
post-publish** scoring that never blocks posting and survives the scorer being down; (2) a cheap **RoBERTa
pre-filter** so the LLM only sees borderline items; (3) a new **relationship-quality** signal feeding a
**Neo4j** graph. The moderator's *brain* (policy prompt, verdict schema, auto-action thresholds,
`moderation_analyses`, the API write-back, the admin AI-flag queue) is worth keeping — so the new system
reuses those contracts and supersedes the rest.

## Decisions

- **Transport: Supabase pgmq**, fed by a Postgres **AFTER INSERT / content-changing UPDATE** trigger
  ("Trigger A") that `pgmq.send()`s a job **atomically** with the content write. Replaces the
  `lib/webhooks.ts` moderation notifier.
- **Full parity** of coverage: `entities`, `comments`, `chat_messages`; INSERT + gated UPDATE. UPDATE is a
  separate, **content-gated** trigger so the write-back and count bumps don't re-enqueue (no loop).
- **Three containers**: one shared RoBERTa model-server image run twice (toxicity:8001, relationship:8002,
  CPU-pinned to disjoint cores) + a worker (consumer + cascade + admin API).
- **Cascade**: toxicity score → gray-zone gate → escalate borderline to **Claude Haiku** using the
  **salvaged** policy prompt + verdict schema; `decide_auto_action` (salvaged) applies removals via the
  API write-back (entity/comment only).
- **Idempotent at-least-once**: pgmq redelivers on crash, so the `moderation_analyses` insert is deduped
  on the pgmq `source_msg_id` (`ON CONFLICT DO NOTHING`, partial unique index, migration `0028`) — keeping
  the append-log (cumulative stats/tokens) rather than an upsert that collapses history; the write-back +
  Neo4j `MERGE` are idempotent too; the consumer pre-checks the msg_id to skip a redundant Haiku call;
  poison messages archived after N reads.
- **Preserve** the admin contract: `moderation_analyses`, the `/v1/:projectId/moderation/*` shapes,
  `/internal/moderation/apply`, and operator JWT — the admin nginx upstream is just repointed to the worker.
- **id-only job payload** `{targetType, targetId, projectId}`; the worker fetches text by id.
- **Neo4j bundled** in compose; **v1 graph** = `(:User)-[:AUTHORED]->(:Content {relationshipScore})` with
  a signed sentiment in [-1,1] (idempotent MERGE + uniqueness constraints); the user→user interaction
  graph is a deferred v2.
- **Cutover now**: `moderator` removed from compose; `apps/moderator` source deletion deferred.
- **DB driver**: asyncpg with `statement_cache_size=0` (Supabase txn pooler `:6543`, `prepare:false`).

## Core logic (the cascade — `worker/pipeline.py`)

```
text = fetch_content_text(target)
tox, rel = await gather(toxicity/score, relationship/score)
if   tox < grayzone_low:  verdict = allow
elif tox >= grayzone_high: verdict = block (high confidence)
else:                      verdict = haiku.assess(text, categories)  # None → review (queue)
trigger = decide_auto_action(verdict, confidence, target_type, project_thresholds)   # salvaged
if trigger and target_type in (entity, comment):
    apply_moderation(status=removed, reason=moderation_reason_text(...))             # API write-back
upsert_analysis(...)                       # idempotent; admin queue source
write_relationship_edge(rel.score)         # Neo4j MERGE (graph schema out of scope)
```

## Touch points

1. `services/scorer/` — new Python project. `scorer/` shared lib (policy/auto_action/verdict/reason
   **verbatim ports**; config/haiku/db/pgmq/neo4j/jwt_auth/models); `model_server/` (FastAPI `/score`);
   `worker/` (consumer, pipeline, model_clients, writeback, analyses, neo4j_writer, admin_api, main);
   `Dockerfile.model-server`, `Dockerfile.worker`, `pyproject.toml`, `requirements*.txt`, `tests/`.
2. `apps/api/drizzle/0027_scorer_pgmq_enqueue.sql` (+ `meta/_journal.json` entry idx 27) — pgmq enable,
   `scorer_jobs` queue, `enqueue_scorer_job()`, the 6 triggers.
3. `docker-compose.yml` — remove `moderator`; add `scorer-toxicity` / `scorer-relationship` /
   `scorer-worker` / `neo4j` + `neo4j-data` volume; repoint `admin.MODERATOR_UPSTREAM`.
4. `.env.example` — `SCORER_*` + `NEO4J_*` block (feature-gated) + the pooler/prepared-statement note.
5. `docs/SCORER.md` — living architecture doc. `CHANGELOG.md` — Added/Changed/Removed under `[Unreleased]`.

## Testing

- **Pure-fn pytest** (real, not stubs): `tests/test_policy.py`, `test_auto_action.py`, `test_verdict.py`
  — prompt/schema text, the auto-action decision table, tolerant verdict parsing. (20 cases, green.)
- **Compose validates** (`docker compose config`): 3 scorer services + neo4j, no moderator, admin upstream
  repointed.
- **Foundation smoke** (impl pass): build images; `/health` 200; `migrate.mjs` applies `0027` idempotently;
  manual `pgmq.send` → worker logs a consumed job with stubbed scores + `pgmq.delete`; operator JWT →
  `/v1/:projectId/moderation/{queue,config}` returns the expected envelope shape.

## Deferred (post-implementation)

The model server, db layer, pgmq, Haiku + write-back, and the v1 Neo4j graph are implemented. Still out:

- **Live integration smoke** against real Supabase pgmq / HF weights / Neo4j / Anthropic.
- **Relationship graph v2** — the user→user `INTERACTED` edge (resolve the reply/DM recipient).
- **Author enrichment** for the admin queue; `/analyze` + `/{id}/remove` admin endpoints (currently 501).
- Deleting `apps/moderator` source + cleaning the dead `webhooks.ts` moderation path.
- torch image-size optimization; Python CI job + docker-publish matrix entries.
