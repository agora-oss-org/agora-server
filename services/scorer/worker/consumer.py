"""The pgmq poll loop.

Read a batch (with a visibility timeout) → process each via ``pipeline.process_job`` → delete
on success; archive a poison message after too many reads. Visibility-timeout redelivery makes
the queue at-least-once, which is why ``pipeline`` + its writers are idempotent.

STUB: the loop structure is real; ``pgmq.read`` returns nothing until ``scorer/db.py`` is wired,
so the loop idles harmlessly during the foundation.
"""

from __future__ import annotations

import asyncio

from scorer import pgmq
from scorer.config import Settings
from scorer.logging import get_logger, log
from scorer.models import ScoreJob

from .pipeline import process_job

logger = get_logger("scorer.worker.consumer")

_MAX_READ_CT = 5  # archive a message after this many redeliveries (poison-message guard)


async def run_consumer(settings: Settings, stop: asyncio.Event) -> None:
    """Long-running consumer loop. Exits when ``stop`` is set."""
    interval = settings.poll_interval_ms / 1000.0
    log(logger, "info", "consumer started", queue=settings.queue, poll_s=interval)
    while not stop.is_set():
        try:
            messages = await pgmq.read(settings, settings.visibility_timeout_s, qty=10)
            for msg in messages:
                if msg.read_ct > _MAX_READ_CT:
                    log(logger, "warn", "poison message archived", msg_id=msg.msg_id, read_ct=msg.read_ct)
                    await pgmq.archive(settings, msg.msg_id)
                    continue
                try:
                    await process_job(settings, ScoreJob(**msg.message))
                    await pgmq.delete(settings, msg.msg_id)
                except Exception:  # noqa: BLE001 — keep the loop alive; message redelivers after vt
                    log(logger, "error", "job failed; will redeliver", msg_id=msg.msg_id)
        except Exception:  # noqa: BLE001
            log(logger, "error", "consumer poll failed")
        await asyncio.wait([asyncio.create_task(stop.wait())], timeout=interval)
