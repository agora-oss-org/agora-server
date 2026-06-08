"""Write the relationship-quality signal as an edge into Neo4j.

Graph schema v1 (see docs/SCORER.md → "The relationship graph"):

    MERGE (u:User {id: author})
    MERGE (c:Content {id: target})  ON CREATE SET type, projectId
    SET c.relationshipScore = <signed sentiment, -1..1>, c.scoredAt = timestamp()
    MERGE (u)-[:AUTHORED]->(c)

All-MERGE → idempotent under pgmq redelivery (a re-run just re-SETs the score). No-op (logged) when
``NEO4J_*`` is unset or the content has no resolvable author (anonymous). The richer user→user
interaction graph (resolving the *recipient* of a reply/DM) is a planned v2 — see the roadmap.
"""

from __future__ import annotations

from scorer.config import Settings
from scorer.logging import get_logger, log
from scorer.neo4j import get_driver

logger = get_logger("scorer.worker.neo4j_writer")

_MERGE = """
merge (u:User {id: $author_id})
merge (c:Content {id: $target_id})
  on create set c.type = $target_type, c.projectId = $project_id
set c.relationshipScore = $score, c.scoredAt = timestamp()
merge (u)-[:AUTHORED]->(c)
"""


async def write_relationship_edge(
    settings: Settings,
    *,
    project_id: str,
    target_type: str,
    target_id: str,
    author_id: str | None,
    relationship_score: float,
) -> None:
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j edge write skipped (not configured)", target_id=target_id)
        return
    if author_id is None:
        log(logger, "debug", "neo4j edge write skipped (no author)", target_id=target_id)
        return
    async with driver.session() as session:
        await session.run(
            _MERGE,
            # str() the ids — they may arrive as asyncpg pgproto.UUID, which the Neo4j driver can't pack.
            author_id=str(author_id),
            target_id=str(target_id),
            target_type=target_type,
            project_id=str(project_id),
            score=float(relationship_score),
        )
    log(logger, "info", "neo4j relationship edge merged", target_id=target_id, score=relationship_score)
