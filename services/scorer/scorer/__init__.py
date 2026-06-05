"""services/scorer — shared library.

Pure, salvaged primitives ported verbatim from ``apps/moderator`` (policy prompts,
auto-action decision, verdict parsing, reason formatting) plus the new I/O adapters
(db, pgmq, neo4j, haiku, jwt). See ``docs/SCORER.md`` for the architecture.
"""

__all__ = ["__version__"]

__version__ = "0.0.1"
