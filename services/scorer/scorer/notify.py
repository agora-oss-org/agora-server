"""LISTEN/NOTIFY wake-up listener.

The enqueue trigger ``pg_notify('scorer_jobs', '')`` at commit (migration 0033); this holds a dedicated
asyncpg connection that LISTENs on that channel and sets an ``asyncio.Event`` so the consumer drains
immediately instead of waiting for the next poll. pgmq remains the durable backstop — if a NOTIFY is
missed (or the listener is down), the poll loop still picks the job up.

IMPORTANT: LISTEN does NOT work over the Supabase transaction pooler (:6543, PgBouncer) — this connects
to ``SCORER_LISTEN_DATABASE_URL`` (a direct/session :5432 DSN). When that's unset, the listener is a
no-op and the consumer falls back to pure polling.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Optional

import asyncpg

from .config import Settings
from .logging import get_logger, log

logger = get_logger("scorer.notify")

_RECONNECT_BACKOFF_S = 2.0
_LIVENESS_CHECK_S = 30.0


class NotifyListener:
    """Sets ``wake`` whenever a NOTIFY arrives on the queue channel. Reconnects on drop."""

    def __init__(self, settings: Settings, wake: asyncio.Event) -> None:
        self._settings = settings
        self._wake = wake
        self._stop = asyncio.Event()
        self._task: Optional[asyncio.Task] = None

    def _on_notify(self, _conn: object, _pid: int, _channel: str, _payload: str) -> None:
        self._wake.set()

    async def start(self) -> None:
        if not self._settings.notify_enabled():
            log(logger, "info", "NOTIFY wake-up disabled (SCORER_LISTEN_DATABASE_URL unset); polling only")
            return
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while not self._stop.is_set():
            conn: Optional[asyncpg.Connection] = None
            try:
                conn = await asyncpg.connect(self._settings.listen_database_url, statement_cache_size=0)
                await conn.add_listener(self._settings.queue, self._on_notify)
                log(logger, "info", "listening for job notifications", channel=self._settings.queue)
                while not self._stop.is_set() and not conn.is_closed():
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(self._stop.wait(), timeout=_LIVENESS_CHECK_S)
            except Exception as exc:  # noqa: BLE001 — keep trying; the poll loop covers the gap
                log(logger, "error", "listener error; reconnecting", err=str(exc))
            finally:
                if conn is not None:
                    with contextlib.suppress(Exception):
                        await conn.close()
            if not self._stop.is_set():
                await asyncio.sleep(_RECONNECT_BACKOFF_S)

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError):
                await asyncio.wait_for(self._task, timeout=5)
            self._task = None
