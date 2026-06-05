"""Async Postgres access (asyncpg).

CRITICAL: ``DATABASE_URL`` is the Supabase transaction pooler (:6543, ``prepare:false``), which does
NOT support prepared statements. The pool is therefore created with ``statement_cache_size=0`` — the
asyncpg equivalent of postgres.js ``prepare:false`` — or every query fails under the pooler.

This module owns: the connection pool, the content-text fetch (per target table), the deduped
``moderation_analyses`` insert (``ON CONFLICT (source_msg_id) DO NOTHING``), the redelivery pre-check,
the per-project moderator config (jsonb merge over env, seeded + 30s cached), and the admin AI-flag
reads (queue / stats / latest / resolve).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Optional

import asyncpg

from .config import ResolvedModeratorConfig, Settings, resolve
from .logging import get_logger, log
from .policy import DEFAULT_MODERATION_CATEGORIES

logger = get_logger("scorer.db")

_pool: Optional[asyncpg.Pool] = None


async def get_pool(settings: Settings) -> asyncpg.Pool:
    """Lazily create the asyncpg pool. statement_cache_size=0 for the Supabase txn pooler."""
    global _pool
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is required")
    if _pool is None:
        _pool = await asyncpg.create_pool(
            settings.database_url,
            statement_cache_size=0,  # txn pooler (PgBouncer) — no prepared statements
            min_size=1,
            max_size=10,
        )
        log(logger, "info", "db pool created")
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


# ── content fetch (id-only job → fetch text/space/author by id) ───────────────
@dataclass
class ContentRow:
    text: str
    space_id: Optional[str]
    author_id: Optional[str]


# Each query returns (title?, content, space_id?, user_id). Entities carry title+content + their own
# space; comments inherit the space from their parent entity; chat messages are conversation-scoped
# (no space). Removed/deleted handling is left to the worker — we score whatever text exists.
_CONTENT_SQL = {
    "entity": "select title, content, space_id, user_id from entities where id = $1",
    "comment": (
        "select c.content, e.space_id, c.user_id "
        "from comments c join entities e on e.id = c.entity_id where c.id = $1"
    ),
    "message": "select content, user_id from chat_messages where id = $1",
}


async def fetch_content(settings: Settings, target_type: str, target_id: str) -> Optional[ContentRow]:
    sql = _CONTENT_SQL.get(target_type)
    if sql is None:
        return None
    pool = await get_pool(settings)
    row = await pool.fetchrow(sql, target_id)
    if row is None:
        return None
    if target_type == "entity":
        text = "\n\n".join(p for p in (row["title"], row["content"]) if p)
        return ContentRow(text=text, space_id=row["space_id"], author_id=row["user_id"])
    if target_type == "comment":
        return ContentRow(text=row["content"] or "", space_id=row["space_id"], author_id=row["user_id"])
    return ContentRow(text=row["content"] or "", space_id=None, author_id=row["user_id"])


# ── moderation_analyses: deduped append + redelivery pre-check ────────────────
_INSERT_ANALYSIS = """
insert into moderation_analyses
  (project_id, target_type, target_id, space_id, verdict, categories, confidence, reason,
   model, auto_actioned, prompt_tokens, completion_tokens, source_msg_id)
values
  ($1, $2::reaction_target, $3, $4, $5::moderation_verdict, $6, $7, $8, $9, $10, $11, $12, $13)
on conflict (source_msg_id) do nothing
"""


async def insert_analysis(
    settings: Settings,
    *,
    project_id: str,
    target_type: str,
    target_id: str,
    space_id: Optional[str],
    verdict: str,
    categories: list[str],
    confidence: float,
    reason: str,
    model: str,
    auto_actioned: bool,
    prompt_tokens: int,
    completion_tokens: int,
    source_msg_id: Optional[int],
) -> None:
    pool = await get_pool(settings)
    await pool.execute(
        _INSERT_ANALYSIS, project_id, target_type, target_id, space_id, verdict, categories,
        confidence, reason, model, auto_actioned, prompt_tokens, completion_tokens, source_msg_id,
    )


async def analysis_exists_for_msg(settings: Settings, source_msg_id: int) -> bool:
    pool = await get_pool(settings)
    row = await pool.fetchrow(
        "select 1 from moderation_analyses where source_msg_id = $1 limit 1", source_msg_id
    )
    return row is not None


# ── per-project moderator config (jsonb merge over env, seeded + 30s cache) ───
_CACHE_TTL_S = 30.0
_cfg_cache: dict[str, tuple[ResolvedModeratorConfig, float]] = {}


async def _seed_categories_if_missing(pool: asyncpg.Pool, project_id: str, raw: Any) -> None:
    """Persist the default taxonomy into a project that has none yet (idempotent; best-effort)."""
    has = isinstance(raw, dict) and isinstance(raw.get("categories"), list) and bool(raw["categories"])
    if has:
        return
    try:
        await pool.execute(
            "update projects set moderator_config = "
            "jsonb_set(coalesce(moderator_config, '{}'::jsonb), '{categories}', $2::jsonb, true) "
            "where id = $1 and (moderator_config -> 'categories') is null",
            project_id, json.dumps(list(DEFAULT_MODERATION_CATEGORIES)),
        )
    except Exception:  # noqa: BLE001 — seeding is best-effort
        log(logger, "error", "failed to seed default categories", project_id=project_id)


async def get_moderator_config(settings: Settings, project_id: str) -> ResolvedModeratorConfig:
    hit = _cfg_cache.get(project_id)
    now = time.monotonic()
    if hit and now - hit[1] < _CACHE_TTL_S:
        return hit[0]
    pool = await get_pool(settings)
    row = await pool.fetchrow("select moderator_config from projects where id = $1", project_id)
    raw = row["moderator_config"] if row else None
    if isinstance(raw, str):  # jsonb may come back as text depending on codec
        raw = json.loads(raw)
    await _seed_categories_if_missing(pool, project_id, raw)
    cfg = resolve(raw, settings)
    _cfg_cache[project_id] = (cfg, now)
    return cfg


# ── admin AI-flag-queue reads ─────────────────────────────────────────────────
async def fetch_queue(
    settings: Settings, project_id: str, page: int, limit: int
) -> tuple[list[asyncpg.Record], int]:
    """Unresolved (block/review, human_resolved_at is null) analyses for a project, newest first."""
    pool = await get_pool(settings)
    where = (
        "where project_id = $1 and human_resolved_at is null "
        "and verdict in ('block','review')"
    )
    total = await pool.fetchval(f"select count(*) from moderation_analyses {where}", project_id)
    rows = await pool.fetch(
        f"select * from moderation_analyses {where} order by created_at desc offset $2 limit $3",
        project_id, (page - 1) * limit, limit,
    )
    return list(rows), int(total or 0)


async def fetch_stats(settings: Settings, project_id: str) -> dict[str, int]:
    pool = await get_pool(settings)
    row = await pool.fetchrow(
        "select "
        "count(*) as total, "
        "count(*) filter (where verdict = 'block') as blocks, "
        "count(*) filter (where verdict = 'review') as reviews, "
        "count(*) filter (where verdict = 'allow') as allows, "
        "count(*) filter (where auto_actioned) as auto_blocks, "
        "coalesce(sum(prompt_tokens), 0) as prompt_tokens, "
        "coalesce(sum(completion_tokens), 0) as completion_tokens "
        "from moderation_analyses where project_id = $1",
        project_id,
    )
    d = dict(row) if row else {}
    prompt = int(d.get("prompt_tokens", 0))
    completion = int(d.get("completion_tokens", 0))
    return {
        "total": int(d.get("total", 0)), "blocks": int(d.get("blocks", 0)),
        "reviews": int(d.get("reviews", 0)), "allows": int(d.get("allows", 0)),
        "autoBlocks": int(d.get("auto_blocks", 0)),
        "promptTokens": prompt, "completionTokens": completion, "totalTokens": prompt + completion,
    }


async def fetch_latest_analysis(
    settings: Settings, project_id: str, target_type: str, target_id: str
) -> Optional[asyncpg.Record]:
    pool = await get_pool(settings)
    return await pool.fetchrow(
        "select * from moderation_analyses "
        "where project_id = $1 and target_type = $2::reaction_target and target_id = $3 "
        "order by created_at desc limit 1",
        project_id, target_type, target_id,
    )


async def resolve_analysis(settings: Settings, project_id: str, analysis_id: str) -> bool:
    """Mark an analysis human-resolved (clears it from the queue). Returns True if a row matched."""
    pool = await get_pool(settings)
    status = await pool.execute(
        "update moderation_analyses set human_resolved_at = now() "
        "where id = $1 and project_id = $2 and human_resolved_at is null",
        analysis_id, project_id,
    )
    # asyncpg returns e.g. "UPDATE 1"
    return status.rsplit(" ", 1)[-1] != "0"
