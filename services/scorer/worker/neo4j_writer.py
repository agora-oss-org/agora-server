"""Write the relationship signals as edges into Neo4j.

Graph schema (see docs/SCORER.md → "The relationship graph"):

v1 — author → content (every scored item):

    MERGE (u:User {id: author})
    MERGE (c:Content {id: target})  ON CREATE SET type, projectId
    SET c.relationshipScore = <signed sentiment, -1..1>, c.scoredAt = timestamp()
    MERGE (u)-[:AUTHORED]->(c)

v2 — the user→user interaction graph (two distinct edge types, combined only at read time):

    (actor)-[:INTERACTED {sourceId, kind, sentiment, projectId, at}]->(recipient)   -- behavioral, append-log
    (follower)-[:FOLLOWS {at}]->(followee)                                          -- structural, retractable

All-MERGE → idempotent under pgmq redelivery (a re-run just re-SETs). The INTERACTED edge is keyed on
``sourceId`` (the comment/reaction id), so a redelivery or content edit re-SETs that one edge while a new
interaction is a new edge; a withdrawn reaction / unfollow DELETEs its edge. No-op (logged) when
``NEO4J_*`` is unset or an endpoint is unresolvable (anonymous, or a self-interaction).
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

# v2 — behavioral edge, keyed on sourceId so the MERGE is stable (sourceId → (actor, recipient)).
_INTERACTED_MERGE = """
merge (a:User {id: $actor_id})
merge (b:User {id: $recipient_id})
merge (a)-[r:INTERACTED {sourceId: $source_id}]->(b)
  on create set r.createdAt = timestamp()
set r.kind = $kind, r.sentiment = $sentiment, r.projectId = $project_id, r.at = timestamp()
"""

_INTERACTED_DELETE = "match ()-[r:INTERACTED {sourceId: $source_id}]->() delete r"

# v2 — structural edge, mirrors the follows table (add → MERGE, remove → DELETE).
_FOLLOW_MERGE = """
merge (a:User {id: $follower_id})
merge (b:User {id: $followed_id})
merge (a)-[r:FOLLOWS]->(b)
  on create set r.createdAt = timestamp()
set r.at = timestamp()
"""

_FOLLOW_DELETE = "match (a:User {id: $follower_id})-[r:FOLLOWS]->(b:User {id: $followed_id}) delete r"

# v2.1 — structural MUTUAL edge from the connections table. Stored directed requester→addressee
# (provenance: who initiated) but mutual in meaning — query undirected: (a)-[:CONNECTED]-(b).
_CONNECTION_MERGE = """
merge (a:User {id: $requester_id})
merge (b:User {id: $addressee_id})
merge (a)-[r:CONNECTED]->(b)
  on create set r.createdAt = timestamp()
set r.at = timestamp()
"""

_CONNECTION_DELETE = "match (a:User {id: $requester_id})-[r:CONNECTED]->(b:User {id: $addressee_id}) delete r"

# Layer-2 — directed FRICTION edge, keyed on sourceId (the report id) so the MERGE is idempotent under
# pgmq redelivery. A report carries no text, so its friction has a constant weight (read back by the
# Weather query at read time and decayed at the friction half-life). Append-only: no delete counterpart
# (a resolved/dismissed report just lets the edge decay — see migration 0039).
FRICTION_REPORT_WEIGHT = 1.0

_FRICTION_MERGE = """
merge (a:User {id: $actor_id})
merge (b:User {id: $recipient_id})
merge (a)-[r:FRICTION {sourceId: $source_id}]->(b)
  on create set r.createdAt = timestamp()
set r.kind = $kind, r.weight = $weight, r.projectId = $project_id, r.at = timestamp()
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


async def write_interaction_edge(
    settings: Settings,
    *,
    project_id: str,
    actor_id: str | None,
    recipient_id: str | None,
    kind: str,
    source_id: str,
    sentiment: float,
) -> None:
    """MERGE a user→user INTERACTED edge keyed on ``source_id``. No-op (logged) when Neo4j is off, an
    endpoint is unresolvable, or it's a self-interaction (no self-loop)."""
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j interaction edge skipped (not configured)", source_id=source_id)
        return
    if not actor_id or not recipient_id:
        log(logger, "debug", "neo4j interaction edge skipped (unresolved endpoint)", source_id=source_id)
        return
    if str(actor_id) == str(recipient_id):
        log(logger, "debug", "neo4j interaction edge skipped (self-interaction)", source_id=source_id)
        return
    async with driver.session() as session:
        await session.run(
            _INTERACTED_MERGE,
            actor_id=str(actor_id),
            recipient_id=str(recipient_id),
            source_id=str(source_id),
            kind=kind,
            sentiment=float(sentiment),
            project_id=str(project_id),
        )
    log(logger, "info", "neo4j interaction edge merged", source_id=source_id, kind=kind, sentiment=sentiment)


async def delete_interaction_edge(settings: Settings, *, source_id: str) -> None:
    """DELETE the INTERACTED edge(s) for ``source_id`` (a withdrawn reaction). Idempotent — a missing
    edge is a no-op."""
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j interaction edge delete skipped (not configured)", source_id=source_id)
        return
    async with driver.session() as session:
        await session.run(_INTERACTED_DELETE, source_id=str(source_id))
    log(logger, "info", "neo4j interaction edge deleted", source_id=source_id)


async def write_follow_edge(settings: Settings, *, follower_id: str, followed_id: str) -> None:
    """MERGE a structural FOLLOWS edge. No-op (logged) when Neo4j is off."""
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j follow edge skipped (not configured)")
        return
    async with driver.session() as session:
        await session.run(_FOLLOW_MERGE, follower_id=str(follower_id), followed_id=str(followed_id))
    log(logger, "info", "neo4j follow edge merged", follower_id=str(follower_id), followed_id=str(followed_id))


async def delete_follow_edge(settings: Settings, *, follower_id: str, followed_id: str) -> None:
    """DELETE the structural FOLLOWS edge (an unfollow). Idempotent — a missing edge is a no-op."""
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j follow edge delete skipped (not configured)")
        return
    async with driver.session() as session:
        await session.run(_FOLLOW_DELETE, follower_id=str(follower_id), followed_id=str(followed_id))
    log(logger, "info", "neo4j follow edge deleted", follower_id=str(follower_id), followed_id=str(followed_id))


async def write_connection_edge(settings: Settings, *, requester_id: str, addressee_id: str) -> None:
    """MERGE the mutual CONNECTED edge (a connection became `connected`). No-op (logged) when Neo4j off."""
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j connection edge skipped (not configured)")
        return
    async with driver.session() as session:
        await session.run(_CONNECTION_MERGE, requester_id=str(requester_id), addressee_id=str(addressee_id))
    log(logger, "info", "neo4j connection edge merged", requester_id=str(requester_id), addressee_id=str(addressee_id))


async def delete_connection_edge(settings: Settings, *, requester_id: str, addressee_id: str) -> None:
    """DELETE the CONNECTED edge (disconnect / left the connected state). Idempotent — missing is a no-op."""
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j connection edge delete skipped (not configured)")
        return
    async with driver.session() as session:
        await session.run(_CONNECTION_DELETE, requester_id=str(requester_id), addressee_id=str(addressee_id))
    log(logger, "info", "neo4j connection edge deleted", requester_id=str(requester_id), addressee_id=str(addressee_id))


async def write_friction_edge(
    settings: Settings,
    *,
    project_id: str,
    actor_id: str | None,
    recipient_id: str | None,
    source_id: str,
    kind: str,
    weight: float = FRICTION_REPORT_WEIGHT,
) -> None:
    """MERGE a directed user→user FRICTION edge keyed on ``source_id`` (the report id). No-op (logged)
    when Neo4j is off, an endpoint is unresolvable (anonymous reporter / chat-message report / deleted
    author), or it's a self-report (no self-loop)."""
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j friction edge skipped (not configured)", source_id=source_id)
        return
    if not actor_id or not recipient_id:
        log(logger, "debug", "neo4j friction edge skipped (unresolved endpoint)", source_id=source_id)
        return
    if str(actor_id) == str(recipient_id):
        log(logger, "debug", "neo4j friction edge skipped (self-report)", source_id=source_id)
        return
    async with driver.session() as session:
        await session.run(
            _FRICTION_MERGE,
            actor_id=str(actor_id),
            recipient_id=str(recipient_id),
            source_id=str(source_id),
            kind=kind,
            weight=float(weight),
            project_id=str(project_id),
        )
    log(logger, "info", "neo4j friction edge merged", source_id=source_id, kind=kind, weight=weight)
