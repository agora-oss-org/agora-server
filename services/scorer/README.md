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

## The cascade (how a verdict is reached)

Both RoBERTas score **in parallel** (`asyncio.gather`), but they do different jobs: **only the
toxicity model gates moderation.** The relationship (sentiment) model's score is written to the Neo4j
graph as signed edge quality — it does **not** influence the removal decision. So "two classifiers"
means one gate + one graph signal, not two moderation votes.

The gate is on **P(toxic)** (`toxicity.scores["toxic"]`), against two thresholds:

| P(toxic) | Verdict | Claude Haiku called? |
|---|---|---|
| `< SCORER_GRAYZONE_LOW` (default `0.30`) | `allow` | ❌ no |
| `≥ SCORER_GRAYZONE_HIGH` (default `0.80`) | `block` (confidence = P(toxic)) | ❌ no |
| in the **gray zone** `[LOW, HIGH)` | escalate → Haiku decides `allow`/`block`/`review` | ✅ yes |

Haiku (`claude-haiku-4-5`, `temperature 0`) only adjudicates the ambiguous middle band — the cheap
classifier handles the confident ends. That's the cost-control design.

### When Haiku is disabled (`ANTHROPIC_API_KEY` unset)

`haiku.assess()` also returns `None` on **any** error (network / non-2xx / unparseable), not just when
the key is missing — a failed adjudication never fails/redelivers the whole job. In every "Haiku didn't
decide" case the gray-zone item falls to verdict **`review`** with `confidence = P(toxic)`.

What happens to a `review` item is then decided by `auto_action.decide_auto_action` against the
project's **review floor** (`MODERATION_REVIEW_AUTO_ACTION_THRESHOLD`):

- **Default `0.0` → the review path is disabled → every gray-zone item goes to the human AI-flag
  queue** (`/v1/:projectId/moderation/*`, admin AI tab). This is the out-of-the-box behavior: **disable
  Haiku and the entire gray zone routes to human review.**
- **⚠️ If an operator raised the review floor above `0`**, a `review` item whose `confidence` (= raw
  P(toxic), always in `[0.30, 0.80)`) meets that floor is **auto-removed on the toxicity score alone** —
  no human, no LLM. So with Haiku off, a nonzero review floor silently turns the upper part of the gray
  band into auto-removals. Check this setting before turning Haiku off if you want "gray → human" to hold.

The two ends are unaffected either way: `≥ 0.80` still auto-`block`s (if `confidence ≥
MODERATION_BLOCK_AUTO_ACTION_THRESHOLD`, default `0.85`), and `< 0.30` still `allow`s. A floor of `0`
disables its path entirely; only `entity`/`comment` are removable (chat is E2E — never scored). All
thresholds are per-project overridable via `projects.moderator_config` (admin **Settings → Moderator**),
overlaid on these env defaults.

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
