# `services/scorer` 🧪💞

Python content **scoring + moderation** subsystem for Agora — **replaces `apps/moderator`**.

Async, post-publish: content publishes instantly, then a **Postgres trigger** enqueues a job on
**Supabase pgmq**; a Python **worker** scores it with two **RoBERTa** classifiers in parallel
(toxicity + relationship-quality), **cascades** borderline toxicity to **Claude Haiku** for a
nuanced verdict, writes removals back through the API (the trust boundary), records the
`moderation_analyses` audit row (the admin AI-flag queue), and MERGEs a relationship edge into
**Neo4j**.

> **Status: FOUNDATION.** The pure salvaged logic (policy prompts, auto-action, verdict parsing,
> reason formatting) is real and unit-tested; ML / pgmq / Neo4j / Haiku I/O are structured **stubs**.
> See [`../../docs/SCORER.md`](../../docs/SCORER.md) for the full architecture.

## The three containers

| Container | Role | Port | CPUs |
|---|---|---|---|
| `scorer-toxicity` | RoBERTa toxicity classifier (FastAPI, model warm in RAM) | 8001 | pinned `0,1` |
| `scorer-relationship` | RoBERTa relationship/sentiment classifier (same image) | 8002 | pinned `2,3` |
| `scorer-worker` | pgmq consumer + cascade + write-back + Neo4j + admin API | 4001 | `4` |

The two model servers are the **same image** (`Dockerfile.model-server`), differentiated by
`SCORER_MODEL` / `SCORER_MODEL_KIND` env. The worker is `Dockerfile.worker`.

## Layout

- `model_server/` — shared RoBERTa HTTP server (`POST /score`, `GET /health|/info`).
- `worker/` — consumer (`consumer.py`), cascade (`pipeline.py`), model clients, write-back, analyses
  upsert, Neo4j writer, and the operator-gated admin API (`admin_api.py`, `/v1/:projectId/moderation/*`).
- `scorer/` — shared lib: `policy.py` `auto_action.py` `verdict.py` `reason.py` (verbatim ports),
  `config.py` (env + per-project merge), `haiku.py` `db.py` `pgmq.py` `neo4j.py` `jwt_auth.py` `models.py`.
- `tests/` — pytest over the real pure functions.

## Dev

```bash
cd services/scorer
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest                          # pure-fn suite (policy / auto_action / verdict)
ruff check . && mypy scorer     # lint + types
```

Not part of the pnpm workspace (it's Python). Docker images build from the **repo root** context.
