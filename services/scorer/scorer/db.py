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
from .models import UserSummary
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
# space; comments inherit the space from their parent entity. (Chat messages are NOT scored — Agora uses
# end-to-end-encrypted secure chat, so the server never sees message plaintext.) Removed/deleted handling
# is left to the worker — we score whatever text exists.
_CONTENT_SQL = {
    "entity": "select title, content, space_id, user_id from entities where id = $1",
    "comment": (
        "select c.content, e.space_id, c.user_id "
        "from comments c join entities e on e.id = c.entity_id where c.id = $1"
    ),
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
    # comment (the only other key in _CONTENT_SQL)
    return ContentRow(text=row["content"] or "", space_id=row["space_id"], author_id=row["user_id"])


# ── v2 interaction-graph recipient resolution (services/scorer relationship graph) ────────────────
@dataclass
class InteractionContext:
    """The actor → recipient pair for a user→user INTERACTED edge. ``actor_id``/``recipient_id`` may be
    None (anonymous/deleted author, or a reaction targeting a chat message) — the caller skips those."""

    actor_id: Optional[str]
    recipient_id: Optional[str]
    kind: str  # 'comment' | 'reply' | 'reaction'
    reaction_type: Optional[str] = None  # set for reactions only (drives the sentiment map)


async def resolve_comment_interaction(
    settings: Settings, comment_id: str
) -> Optional[InteractionContext]:
    """Actor + recipient + kind for a comment/reply. The recipient is the entity author (a top-level
    comment) or the parent-comment author (a reply). None if the comment is gone."""
    pool = await get_pool(settings)
    row = await pool.fetchrow(
        "select c.user_id as actor_id, "
        "case when c.parent_id is null then e.user_id else p.user_id end as recipient_id, "
        "case when c.parent_id is null then 'comment' else 'reply' end as kind "
        "from comments c "
        "join entities e on e.id = c.entity_id "
        "left join comments p on p.id = c.parent_id "
        "where c.id = $1",
        comment_id,
    )
    if row is None:
        return None
    return InteractionContext(
        actor_id=str(row["actor_id"]) if row["actor_id"] is not None else None,
        recipient_id=str(row["recipient_id"]) if row["recipient_id"] is not None else None,
        kind=str(row["kind"]),
    )


async def resolve_reaction_interaction(
    settings: Settings, reaction_id: str
) -> Optional[InteractionContext]:
    """Actor + recipient + reaction_type for a reaction on an entity/comment. ``recipient_id`` is None
    when the target is a chat message (``target_type='message'`` — out of the relationship graph's
    scope) or its author is gone. None if the reaction row itself is gone (already removed)."""
    pool = await get_pool(settings)
    row = await pool.fetchrow(
        "select r.user_id as actor_id, r.reaction_type as reaction_type, "
        "case r.target_type "
        "  when 'entity' then (select user_id from entities where id = r.target_id) "
        "  when 'comment' then (select user_id from comments where id = r.target_id) "
        "  else null end as recipient_id "
        "from reactions r where r.id = $1",
        reaction_id,
    )
    if row is None:
        return None
    return InteractionContext(
        actor_id=str(row["actor_id"]) if row["actor_id"] is not None else None,
        recipient_id=str(row["recipient_id"]) if row["recipient_id"] is not None else None,
        kind="reaction",
        reaction_type=str(row["reaction_type"]),
    )


@dataclass
class FrictionContext:
    """The reporter → subject pair for a Layer-2 FRICTION edge. Either id may be None — ``actor_id`` is
    None for an anonymous report (``reporter_id`` null), ``recipient_id`` is None for a chat-message
    report (``target_type='message'`` — secure chat, out of the graph's scope) or a deleted/anonymous
    target author; the caller skips those. ``kind`` is always ``'report'`` for now (the one friction
    source that exists — there is no block/mute feature)."""

    actor_id: Optional[str]
    recipient_id: Optional[str]
    kind: str = "report"


async def resolve_report_friction(
    settings: Settings, report_id: str
) -> Optional[FrictionContext]:
    """Reporter (actor) + subject (recipient) for a report's FRICTION edge. The subject is the AUTHOR of
    the reported content (entity/comment); a chat-message report has no graph recipient. None if the
    report row itself is gone (already deleted)."""
    pool = await get_pool(settings)
    row = await pool.fetchrow(
        "select r.reporter_id as actor_id, "
        "case r.target_type "
        "  when 'entity' then (select user_id from entities where id = r.target_id) "
        "  when 'comment' then (select user_id from comments where id = r.target_id) "
        "  else null end as recipient_id "
        "from reports r where r.id = $1",
        report_id,
    )
    if row is None:
        return None
    return FrictionContext(
        actor_id=str(row["actor_id"]) if row["actor_id"] is not None else None,
        recipient_id=str(row["recipient_id"]) if row["recipient_id"] is not None else None,
        kind="report",
    )


async def resolve_co_participants(
    settings: Settings, *, comment_id: str, actor_id: str, lookback_days: int, max_participants: int
) -> list[str]:
    """Distinct other users who also commented on the SAME entity (any thread depth) within the
    CO_PARTICIPATES lookback window, most-recent-first, capped at ``max_participants``. Excludes the
    triggering commenter, anonymous (null-author) and soft-deleted comments. Empty list if the comment
    is gone or has no co-participants."""
    pool = await get_pool(settings)
    rows = await pool.fetch(
        "select c2.user_id "
        "from comments c1 "
        "join comments c2 on c2.entity_id = c1.entity_id "
        "where c1.id = $1 "
        "  and c2.user_id is not null "
        "  and c2.user_id <> $2 "
        "  and c2.deleted_at is null "
        "  and c2.created_at >= now() - make_interval(days => $3) "
        "group by c2.user_id "
        "order by max(c2.created_at) desc "
        "limit $4",
        comment_id,
        actor_id,
        lookback_days,
        max_participants,
    )
    return [str(r["user_id"]) for r in rows]


# ── moderation_analyses: deduped append + redelivery pre-check ────────────────
_INSERT_ANALYSIS = """
insert into moderation_analyses
  (project_id, target_type, target_id, space_id, verdict, categories, confidence, reason,
   model, auto_actioned, prompt_tokens, completion_tokens, source_msg_id)
values
  ($1, $2::reaction_target, $3, $4, $5::moderation_verdict, $6, $7, $8, $9, $10, $11, $12, $13)
-- the dedup index is PARTIAL (migration 0028: `where source_msg_id is not null`), so the ON CONFLICT
-- arbiter must repeat that predicate to match it. NULL source_msg_id (on-demand /analyze) → no conflict.
on conflict (source_msg_id) where source_msg_id is not null do nothing
returning *
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
) -> Optional[asyncpg.Record]:
    """Insert the analysis row, returning it. None on a dedup conflict (redelivered msg already recorded)."""
    pool = await get_pool(settings)
    return await pool.fetchrow(
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


_AUTHOR_SQL = {
    "entity": "select id, user_id from entities where id = any($1::uuid[])",
    "comment": "select id, user_id from comments where id = any($1::uuid[])",
}


async def fetch_authors(settings: Settings, targets: list[tuple[str, str]]) -> dict[str, UserSummary]:
    """Resolve (targetType, targetId) → author UserSummary for the admin queue (port of authors.ts).
    Batched: one query per target table + one profiles query (no N+1)."""
    pool = await get_pool(settings)
    target_to_user: dict[str, str] = {}
    for kind, sql in _AUTHOR_SQL.items():
        ids = [tid for tt, tid in targets if tt == kind]
        if not ids:
            continue
        for row in await pool.fetch(sql, ids):
            if row["user_id"] is not None:
                target_to_user[str(row["id"])] = str(row["user_id"])
    user_ids = list(set(target_to_user.values()))
    profiles: dict[str, UserSummary] = {}
    if user_ids:
        for row in await pool.fetch(
            "select id, username, name, reputation from profiles where id = any($1::uuid[])", user_ids
        ):
            profiles[str(row["id"])] = UserSummary(
                id=str(row["id"]), username=row["username"], name=row["name"],
                reputation=int(row["reputation"] or 0),
            )
    return {tid: profiles[uid] for tid, uid in target_to_user.items() if uid in profiles}


async def fetch_analysis_by_id(
    settings: Settings, project_id: str, analysis_id: str
) -> Optional[asyncpg.Record]:
    pool = await get_pool(settings)
    return await pool.fetchrow(
        "select * from moderation_analyses where id = $1 and project_id = $2", analysis_id, project_id
    )


async def resolve_analysis(
    settings: Settings, project_id: str, analysis_id: str
) -> Optional[asyncpg.Record]:
    """Mark an analysis human-resolved (clears it from the queue); returns the updated row, None if absent."""
    pool = await get_pool(settings)
    return await pool.fetchrow(
        "update moderation_analyses set human_resolved_at = now() "
        "where id = $1 and project_id = $2 returning *",
        analysis_id, project_id,
    )


async def mark_removed(
    settings: Settings, project_id: str, analysis_id: str
) -> Optional[asyncpg.Record]:
    """After a successful write-back removal: resolve + flag auto_actioned; returns the updated row."""
    pool = await get_pool(settings)
    return await pool.fetchrow(
        "update moderation_analyses set human_resolved_at = now(), auto_actioned = true "
        "where id = $1 and project_id = $2 returning *",
        analysis_id, project_id,
    )
