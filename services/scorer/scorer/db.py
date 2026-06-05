"""Async Postgres access (asyncpg).

CRITICAL: ``DATABASE_URL`` is the Supabase transaction pooler (:6543, ``prepare:false``), which
does NOT support prepared statements. asyncpg MUST therefore be created with
``statement_cache_size=0`` or every query fails under the pooler. This mirrors the API's
``postgres.js`` ``prepare:false``.

STUB: connection-pool lifecycle is sketched; the actual queries (config fetch, content-text
fetch by id, ``moderation_analyses`` upsert, admin-queue reads) are implemented in the
worker modules during the implementation pass.
"""

from __future__ import annotations

from typing import Any, Optional

from .config import Settings
from .logging import get_logger, log

logger = get_logger("scorer.db")

_pool: Optional[Any] = None  # asyncpg.Pool once wired


async def get_pool(settings: Settings) -> Any:
    """Lazily create the asyncpg pool (statement_cache_size=0 for the txn pooler).

    STUB: returns the pool once asyncpg is wired. Raises if DATABASE_URL is unset.
    """
    global _pool
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is required")
    if _pool is None:
        # TODO(scorer): import asyncpg; _pool = await asyncpg.create_pool(
        #     settings.database_url, statement_cache_size=0, min_size=1, max_size=10)
        log(logger, "warn", "db pool requested but asyncpg not wired yet (foundation stub)")
        raise NotImplementedError("asyncpg pool not wired in the foundation pass")
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        # TODO(scorer): await _pool.close()
        _pool = None


async def fetch_content_text(settings: Settings, target_type: str, target_id: str) -> Optional[str]:
    """Fetch the text to score for a job (id-only payload → worker fetches text).

    STUB: SELECT title/content FROM entities, content FROM comments/messages by id.
    Entities join title+content; comments/messages use content alone.
    """
    log(logger, "debug", "fetch_content_text (stub)", target_type=target_type, target_id=target_id)
    return None
