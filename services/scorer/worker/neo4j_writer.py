"""Write the relationship-quality score as an edge into Neo4j.

FOUNDATION ONLY — the graph model (which nodes, which edge type, properties, indexes) is OUT
OF SCOPE. This is an idempotent ``MERGE`` skeleton: a redelivered job must not create a
duplicate edge. No-op (logged) when ``NEO4J_*`` is unset.

STUB: the Cypher is sketched as a MERGE; wired when the graph schema is designed.
"""

from __future__ import annotations

from scorer.config import Settings
from scorer.logging import get_logger, log
from scorer.neo4j import get_driver

logger = get_logger("scorer.worker.neo4j_writer")


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
    # TODO(scorer): graph model is out of scope — illustrative MERGE only:
    #   MERGE (a)-[r:INTERACTED {project:$p, target:$t}]->(b) SET r.relationship = $score
    log(logger, "info", "neo4j MERGE relationship edge (stub)", target_id=target_id, score=relationship_score)
