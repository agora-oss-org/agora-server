"""Neo4j async driver connection + schema constraints (lazy, feature-gated).

When ``NEO4J_*`` is unset, ``neo4j_enabled()`` is false and everything here is a no-op (the
relationship-edge write degrades to a logged skip — see ``worker/neo4j_writer.py``).

Graph schema (v1) — see ``docs/SCORER.md`` "The relationship graph":
  (:User {id})  -[:AUTHORED]->  (:Content {id, type, projectId, relationshipScore, scoredAt})
Uniqueness constraints on ``User.id`` and ``Content.id`` back the idempotent MERGE (and create the
supporting indexes). ``ensure_constraints`` is called once on worker startup.
"""

from __future__ import annotations

from typing import Any, Optional

from .config import Settings
from .logging import get_logger, log

logger = get_logger("scorer.neo4j")

_driver: Optional[Any] = None  # neo4j.AsyncDriver


async def get_driver(settings: Settings) -> Optional[Any]:
    """Lazily create the async Neo4j driver, or None when not configured."""
    if not settings.neo4j_enabled():
        return None
    global _driver
    if _driver is None:
        from neo4j import AsyncGraphDatabase  # lazy import

        _driver = AsyncGraphDatabase.driver(
            settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)
        )
        log(logger, "info", "neo4j driver created")
    return _driver


async def close_driver() -> None:
    global _driver
    if _driver is not None:
        await _driver.close()
        _driver = None


async def ensure_constraints(settings: Settings) -> None:
    """Create the uniqueness constraints the MERGE relies on (idempotent). Best-effort."""
    driver = await get_driver(settings)
    if driver is None:
        return
    try:
        async with driver.session() as session:
            await session.run("create constraint scorer_user_id if not exists for (u:User) require u.id is unique")
            await session.run("create constraint scorer_content_id if not exists for (c:Content) require c.id is unique")
        log(logger, "info", "neo4j constraints ensured")
    except Exception as exc:  # noqa: BLE001 — non-fatal; the worker can run without the graph
        log(logger, "error", "failed to ensure neo4j constraints", err=str(exc))
