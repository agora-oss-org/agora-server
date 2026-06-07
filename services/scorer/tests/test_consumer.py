"""Consumer wake-up: _wait_for_work returns early on wake/stop, falls back to the poll timeout."""

from __future__ import annotations

import asyncio
import dataclasses
import time

from scorer.config import Settings
from scorer.notify import NotifyListener
from worker.consumer import _wait_for_work


async def test_wake_returns_immediately() -> None:
    stop, wake = asyncio.Event(), asyncio.Event()
    wake.set()
    start = time.monotonic()
    await _wait_for_work(stop, wake, timeout=5)
    assert time.monotonic() - start < 1.0  # did not wait the full 5s


async def test_stop_returns_immediately() -> None:
    stop = asyncio.Event()
    stop.set()
    start = time.monotonic()
    await _wait_for_work(stop, None, timeout=5)
    assert time.monotonic() - start < 1.0


async def test_idle_falls_back_to_poll_timeout() -> None:
    stop, wake = asyncio.Event(), asyncio.Event()
    start = time.monotonic()
    await _wait_for_work(stop, wake, timeout=0.1)
    assert time.monotonic() - start >= 0.1  # no event → waited the interval


async def test_listener_noop_when_disabled() -> None:
    settings = dataclasses.replace(Settings(), listen_database_url=None)
    listener = NotifyListener(settings, asyncio.Event())
    await listener.start()
    assert listener._task is None  # no background task spun up
    await listener.stop()  # safe to stop a never-started listener
