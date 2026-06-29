"""Neo4j async driver connection + schema constraints (lazy, feature-gated).

When ``NEO4J_*`` is unset, ``neo4j_enabled()`` is false and everything here is a no-op (the
relationship-edge write degrades to a logged skip — see ``worker/neo4j_writer.py``).

Graph schema (v1) — see ``docs/SCORER.md`` "The relationship graph":
  (:User {id})  -[:AUTHORED]->  (:Content {id, type, projectId, relationshipScore, scoredAt})
Uniqueness constraints on ``User.id`` and ``Content.id`` back the idempotent MERGE (and create the
supporting indexes). ``ensure_constraints`` is called once on worker startup.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Optional

from .config import Settings
from .logging import get_logger, log

logger = get_logger("scorer.neo4j")

_CONSTRAINT_ATTEMPTS = 15
_CONSTRAINT_BACKOFF_S = 2.0

# Neo4j/DozerDB database naming rules: 3-63 chars, must START with an ASCII letter, then lowercase
# alphanumerics / dots / dashes (no underscores). We validate the name before interpolating it into
# the CREATE DATABASE statement — that DDL takes no bound parameter for the name, so the regex is the
# injection guard (security-first; the driver's `database=` kwarg below is safe regardless, as it's a
# protocol field, not string-interpolated Cypher).
_DB_NAME_RE = re.compile(r"^[a-z][a-z0-9.-]{2,62}$")


def valid_db_name(name: str) -> bool:
    """Whether `name` is a safe DozerDB database name to interpolate into CREATE DATABASE DDL."""
    return bool(_DB_NAME_RE.match(name))


_driver: Optional[Any] = None  # neo4j.AsyncDriver


def db_session(driver: Any, settings: Settings) -> Any:
    """Open a session bound to the configured DozerDB database (default `neo4j`). `database=` is a
    driver protocol field (not Cypher), so it needs no name validation here."""
    return driver.session(database=settings.neo4j_database)


async def get_driver(settings: Settings) -> Optional[Any]:
    """Lazily create the async Neo4j driver, or None when not configured."""
    if not settings.neo4j_enabled():
        return None
    global _driver
    if _driver is None:
        from neo4j import AsyncGraphDatabase  # lazy import

        creds = settings.neo4j_credentials()
        assert settings.neo4j_uri and creds  # neo4j_enabled() above guarantees this
        _driver = AsyncGraphDatabase.driver(
            settings.neo4j_uri, auth=creds
        )
        log(logger, "info", "neo4j driver created")
    return _driver


async def close_driver() -> None:
    global _driver
    if _driver is not None:
        await _driver.close()
        _driver = None


async def ensure_constraints(settings: Settings) -> None:
    """Create the uniqueness constraints the MERGE relies on (idempotent). Best-effort, with retry —
    on a cold ``docker compose up`` the worker usually beats Neo4j to ready, so we back off and retry
    until Bolt is up (or give up after ~30s and let the consumer run without the constraints)."""
    if not settings.neo4j_enabled():
        return
    db = settings.neo4j_database
    if db != "neo4j" and not valid_db_name(db):
        log(logger, "error", "invalid NEO4J_DATABASE name; skipping neo4j setup", database=db)
        return
    driver = await get_driver(settings)
    if driver is None:
        return
    for attempt in range(1, _CONSTRAINT_ATTEMPTS + 1):
        try:
            # Create the target DozerDB database if it doesn't exist (DozerDB CREATE DATABASE both
            # creates and brings it online — no separate "join"). Run against the `system` db. The
            # default `neo4j` always exists, so skip it. `db` is regex-validated above; backticks let
            # Cypher parse names with hyphens (e.g. agora-graph).
            if db != "neo4j":
                async with driver.session(database="system") as system_session:
                    await system_session.run(f"CREATE DATABASE `{db}` IF NOT EXISTS")
            async with db_session(driver, settings) as session:
                await session.run("create constraint scorer_user_id if not exists for (u:User) require u.id is unique")
                await session.run("create constraint scorer_content_id if not exists for (c:Content) require c.id is unique")
                # Read-side support: @agora/api's Weather query filters INTERACTED by projectId
                # (single shared graph, query-time scoping). Without this the planner scans every
                # INTERACTED edge across all projects per weather window.
                await session.run("create index scorer_interacted_project if not exists for ()-[r:INTERACTED]-() on (r.projectId)")
                # Same read-side support for the Layer-2 FRICTION edge (Weather folds it into the
                # friction term, scoped by projectId) — see migration 0039.
                await session.run("create index scorer_friction_project if not exists for ()-[r:FRICTION]-() on (r.projectId)")
            log(logger, "info", "neo4j constraints ensured", attempt=attempt)
            return
        except Exception as exc:  # noqa: BLE001 — Neo4j may still be booting; retry
            if attempt == _CONSTRAINT_ATTEMPTS:
                log(logger, "error", "failed to ensure neo4j constraints (gave up)")
                log(logger, "debug", "neo4j constraints error", err=str(exc))
                return
            await asyncio.sleep(_CONSTRAINT_BACKOFF_S)
