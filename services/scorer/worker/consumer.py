"""The pgmq poll loop.

Read a batch (with a visibility timeout) → process each via ``pipeline.process_job`` → delete
on success; archive a poison message after too many reads. Visibility-timeout redelivery makes
the queue at-least-once, which is why ``pipeline`` + its writers are idempotent.

A NOTIFY ``wake`` event (set by ``scorer/notify.py`` when configured) drains the queue immediately
instead of waiting for the next poll; the poll interval remains the durability backstop.
"""

from __future__ import annotations

import asyncio
import contextlib
import traceback
from typing import Optional

from scorer import pgmq
from scorer.config import Settings
from scorer.logging import get_logger, log
from scorer.models import ScoreJob

from . import analyses
from .pipeline import process_job

logger = get_logger("scorer.worker.consumer")

_MAX_READ_CT = 5  # archive a message after this many redeliveries (poison-message guard)


async def _wait_for_work(stop: asyncio.Event, wake: Optional[asyncio.Event], timeout: float) -> None:
    """Wait up to ``timeout`` (poll fallback), returning early on stop or a NOTIFY wake."""
    events = [stop] + ([wake] if wake is not None else [])
    tasks = [asyncio.create_task(e.wait()) for e in events]
    try:
        await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await t


async def run_consumer(settings: Settings, stop: asyncio.Event, wake: Optional[asyncio.Event] = None) -> None:
    """Long-running consumer loop. Exits when ``stop`` is set; wakes early on a NOTIFY ``wake``."""
    interval = settings.poll_interval_ms / 1000.0
    log(logger, "info", "consumer started", queue=settings.queue, poll_s=interval, notify=wake is not None)
    while not stop.is_set():
        # Clear BEFORE draining: a NOTIFY arriving during the drain re-sets wake → we loop again
        # rather than losing it. (A spurious wake just costs one empty poll — safe.)
        if wake is not None:
            wake.clear()
        try:
            messages = await pgmq.read(settings, settings.visibility_timeout_s, qty=10)
            for msg in messages:
                if msg.read_ct > _MAX_READ_CT:
                    log(logger, "warn", "poison message archived", msg_id=msg.msg_id, read_ct=msg.read_ct)
                    await pgmq.archive(settings, msg.msg_id)
                    continue
                # Redelivery pre-check: if a prior delivery already recorded this msg_id, ack and skip
                # — avoids re-scoring and a redundant Haiku call. (The ON CONFLICT insert is the
                # correctness backstop; this just saves the work. read_ct == 1 on first delivery.)
                if msg.read_ct > 1 and await analyses.analysis_exists_for_msg(settings, msg.msg_id):
                    log(logger, "info", "already processed; acking redelivery", msg_id=msg.msg_id)
                    await pgmq.delete(settings, msg.msg_id)
                    continue
                try:
                    await process_job(settings, ScoreJob(**msg.message), msg_id=msg.msg_id)
                    await pgmq.delete(settings, msg.msg_id)
                except Exception as exc:  # noqa: BLE001 — keep the loop alive; message redelivers after vt
                    # Keep error-level clean (no payload/content/trace that might carry sensitive data);
                    # the diagnostic detail goes to debug (off by default; set LOG_LEVEL=debug to see it).
                    log(logger, "error", "job failed; will redeliver", msg_id=msg.msg_id)
                    log(logger, "debug", "job failure detail", msg_id=msg.msg_id,
                        err=repr(exc), trace=traceback.format_exc())
        except Exception:  # noqa: BLE001
            log(logger, "error", "consumer poll failed")
        # Sleep up to one interval, but wake immediately on stop or a NOTIFY.
        await _wait_for_work(stop, wake, interval)
