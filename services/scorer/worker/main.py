"""Worker entrypoint: serves the admin HTTP API AND runs the pgmq consumer loop together.

The FastAPI app (admin endpoints + /health) and the long-running consumer share one process:
the consumer is started as an asyncio background task on startup and stopped on shutdown. This
is the single ``scorer-worker`` container; it publishes ``SCORER_ADMIN_PORT`` (4001) for the
admin nginx upstream.
"""

from __future__ import annotations

import asyncio
import contextlib

import uvicorn
from fastapi import FastAPI

from scorer import db, neo4j
from scorer.config import get_settings
from scorer.logging import get_logger, log
from scorer.notify import NotifyListener

from .admin_api import router as admin_router
from .consumer import run_consumer

logger = get_logger("scorer.worker")


def create_app() -> FastAPI:
    app = FastAPI(title="agora-scorer-worker")
    app.include_router(admin_router)
    stop = asyncio.Event()
    wake = asyncio.Event()
    consumer_task: asyncio.Task | None = None
    listener: NotifyListener | None = None

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.on_event("startup")
    async def _startup() -> None:
        nonlocal consumer_task, listener
        settings = get_settings()
        await neo4j.ensure_constraints(settings)  # best-effort; no-op when NEO4J_* unset
        listener = NotifyListener(settings, wake)
        await listener.start()  # no-op when SCORER_LISTEN_DATABASE_URL unset
        consumer_task = asyncio.create_task(run_consumer(settings, stop, wake))
        log(logger, "info", "worker started", admin_port=settings.admin_port)

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        stop.set()
        if listener is not None:
            await listener.stop()
        if consumer_task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await consumer_task
        await db.close_pool()
        await neo4j.close_driver()

    return app


app = create_app()


def main() -> None:
    settings = get_settings()
    uvicorn.run("worker.main:app", host="0.0.0.0", port=settings.admin_port, log_config=None)


if __name__ == "__main__":
    main()
