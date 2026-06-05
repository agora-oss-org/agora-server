"""Thin wrappers over the Supabase pgmq SQL functions, via ``scorer/db.py``'s pool.

The queue + the AFTER INSERT/UPDATE enqueue trigger are created by the API migration
``apps/api/drizzle/0027_scorer_pgmq_enqueue.sql``. The worker is a CONSUMER: ``read`` (with a
visibility timeout) → process → ``delete`` on success; ``archive`` a poison message after N reads.

pgmq is AT-LEAST-ONCE (a crash between process and delete redelivers after the visibility timeout),
so the worker's downstream writes are idempotent — see ``worker/analyses.py`` (dedup on
``source_msg_id``) and ``worker/neo4j_writer.py`` (MERGE).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .config import Settings
from .db import get_pool


@dataclass
class QueueMessage:
    msg_id: int
    read_ct: int
    message: dict[str, Any]


async def read(settings: Settings, vt_seconds: int, qty: int = 1) -> list[QueueMessage]:
    """``pgmq.read($queue, $vt, $qty)`` — claim up to ``qty`` messages, hidden for ``vt`` seconds."""
    pool = await get_pool(settings)
    rows = await pool.fetch(
        "select msg_id, read_ct, message from pgmq.read($1, $2, $3)",
        settings.queue, vt_seconds, qty,
    )
    out: list[QueueMessage] = []
    for r in rows:
        msg = r["message"]
        if isinstance(msg, str):  # jsonb often comes back as text
            msg = json.loads(msg)
        out.append(QueueMessage(msg_id=int(r["msg_id"]), read_ct=int(r["read_ct"]), message=msg or {}))
    return out


async def delete(settings: Settings, msg_id: int) -> None:
    """``pgmq.delete($queue, $msg_id)`` — ack a successfully-processed message."""
    pool = await get_pool(settings)
    await pool.execute("select pgmq.delete($1, $2::bigint)", settings.queue, msg_id)


async def archive(settings: Settings, msg_id: int) -> None:
    """``pgmq.archive($queue, $msg_id)`` — move a poison message off the queue into its archive."""
    pool = await get_pool(settings)
    await pool.execute("select pgmq.archive($1, $2::bigint)", settings.queue, msg_id)
