#!/usr/bin/env python3
"""Smoke-test CLI: run the REAL CO_PARTICIPATES writer against a live Neo4j.

Writer-side half of the end-to-end seam smoke test
(docs/superpowers/specs/2026-06-16-co-participates-smoke-test-design.md), driven by
scripts/smoke/co-participates.sh. Builds Settings pointed at TEST_NEO4J_URI / TEST_NEO4J_AUTH and calls
``worker.neo4j_writer.write_co_participates_edge`` — exercising the actual ``_CO_PARTICIPATES_MERGE``
Cypher, no hand-copied query. The companion TS reader then reads the edge back; a label/property drift
between the two would surface as a silent zero-result.

Run from ``services/scorer`` with the package importable, e.g.:
    PYTHONPATH=. .venv/bin/python scripts/smoke_write_co_participates.py \\
        --project <uuid> --actor <uuid> --participant <uuid>
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import os
import sys

from scorer.config import Settings
from scorer.neo4j import close_driver
from worker import neo4j_writer


async def _run(project_id: str, actor_id: str, participant_id: str) -> None:
    uri = os.environ.get("TEST_NEO4J_URI") or ""
    auth = os.environ.get("TEST_NEO4J_AUTH") or ""
    if not uri or not auth:
        print("TEST_NEO4J_URI and TEST_NEO4J_AUTH must be set", file=sys.stderr)
        raise SystemExit(2)
    # Point a fresh Settings at the test graph (mirrors tests/test_pipeline.py's replace() pattern).
    settings = dataclasses.replace(Settings(), neo4j_uri=uri, neo4j_auth=auth)
    if not settings.neo4j_enabled():
        print(
            "settings.neo4j_enabled() is False — check TEST_NEO4J_AUTH is 'user/password'",
            file=sys.stderr,
        )
        raise SystemExit(2)
    try:
        await neo4j_writer.write_co_participates_edge(
            settings,
            project_id=project_id,
            actor_id=actor_id,
            participant_id=participant_id,
            max_weight=10.0,
        )
    finally:
        await close_driver()
    print(f"wrote CO_PARTICIPATES edge: {actor_id} <-> {participant_id} (project {project_id})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Write one CO_PARTICIPATES edge into the test Neo4j.")
    parser.add_argument("--project", required=True, help="projectId stamped on the edge")
    parser.add_argument("--actor", required=True, help="one endpoint (the commenter)")
    parser.add_argument("--participant", required=True, help="the other endpoint (co-commenter)")
    args = parser.parse_args()
    asyncio.run(_run(args.project, args.actor, args.participant))


if __name__ == "__main__":
    main()
