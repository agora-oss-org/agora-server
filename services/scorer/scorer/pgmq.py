"""Thin wrappers over the Supabase pgmq SQL functions, via ``scorer/db.py``.

The queue + the AFTER INSERT/UPDATE enqueue trigger are created by the API migration
``apps/api/drizzle/0026_*.sql``. The worker is a CONSUMER: ``read`` (with a visibility
timeout) → process → ``delete`` on success; ``archive`` a poison message after N reads.

pgmq is AT-LEAST-ONCE (a crash between process and delete redelivers after the visibility
timeout), so the worker's downstream writes MUST be idempotent — see ``worker/analyses.py``
(upsert keyed by target) and ``worker/neo4j_writer.py`` (MERGE).

STUB: SQL bodies are sketched as the exact pgmq calls; wired in the implementation pass.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .config import Settings
from .logging import get_logger, log

logger = get_logger("scorer.pgmq")


@dataclass
class QueueMessage:
    msg_id: int
    read_ct: int
    message: dict[str, Any]


async def read(settings: Settings, vt_seconds: int, qty: int = 1) -> list[QueueMessage]:
    """``SELECT * FROM pgmq.read($queue, $vt, $qty)`` — hides messages for ``vt`` seconds.

    STUB: returns no messages until db.py is wired.
    """
    log(logger, "debug", "pgmq.read (stub)", queue=settings.queue, vt=vt_seconds, qty=qty)
    return []


async def delete(settings: Settings, msg_id: int) -> None:
    """``SELECT pgmq.delete($queue, $msg_id)`` — ack a successfully-processed message."""
    log(logger, "debug", "pgmq.delete (stub)", queue=settings.queue, msg_id=msg_id)


async def archive(settings: Settings, msg_id: int) -> None:
    """``SELECT pgmq.archive($queue, $msg_id)`` — move a poison message off the queue."""
    log(logger, "debug", "pgmq.archive (stub)", queue=settings.queue, msg_id=msg_id)
