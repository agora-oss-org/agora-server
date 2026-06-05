"""Neo4j driver connection (lazy, feature-gated).

FOUNDATION ONLY — the graph schema (node labels, edge types, indexes, queries) is OUT OF
SCOPE. This module just owns the async driver lifecycle from ``NEO4J_*`` env. When ``NEO4J_*``
is unset, ``neo4j_enabled()`` is false and the relationship-edge write is a logged no-op (see
``worker/neo4j_writer.py``).
"""

from __future__ import annotations

from typing import Any, Optional

from .config import Settings
from .logging import get_logger, log

logger = get_logger("scorer.neo4j")

_driver: Optional[Any] = None  # neo4j.AsyncDriver once wired


async def get_driver(settings: Settings) -> Optional[Any]:
    """Lazily create the async Neo4j driver, or None when not configured.

    STUB: returns None until the neo4j driver is wired.
    """
    if not settings.neo4j_enabled():
        return None
    global _driver
    if _driver is None:
        # TODO(scorer): from neo4j import AsyncGraphDatabase
        # _driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password))
        log(logger, "warn", "neo4j driver requested but not wired yet (foundation stub)")
        return None
    return _driver


async def close_driver() -> None:
    global _driver
    if _driver is not None:
        # TODO(scorer): await _driver.close()
        _driver = None
