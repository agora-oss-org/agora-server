"""Worker entrypoint: serves the admin HTTP API AND runs the pgmq consumer loop together.

The FastAPI app (admin endpoints + /health) and the long-running consumer share one process: a
``lifespan`` handler starts the NOTIFY listener + the consumer task on startup and tears them down on
shutdown. This is the single ``scorer-worker`` container; it publishes ``SCORER_ADMIN_PORT`` (4001) for
the admin nginx upstream.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import AsyncIterator

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
    stop = asyncio.Event()
    wake = asyncio.Event()

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        settings = get_settings()
        # Background (retries until Neo4j is up) so a cold-start race doesn't block the worker.
        constraints_task = asyncio.create_task(neo4j.ensure_constraints(settings))
        listener = NotifyListener(settings, wake)
        await listener.start()  # no-op when SCORER_LISTEN_DATABASE_URL unset
        consumer_task = asyncio.create_task(run_consumer(settings, stop, wake))
        log(logger, "info", "worker started", admin_port=settings.admin_port)
        try:
            yield
        finally:
            stop.set()
            constraints_task.cancel()
            await listener.stop()
            for task in (constraints_task, consumer_task):
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await db.close_pool()
            await neo4j.close_driver()

    app = FastAPI(title="agora-scorer-worker", lifespan=lifespan)
    app.include_router(admin_router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()


def main() -> None:
    settings = get_settings()
    uvicorn.run("worker.main:app", host="0.0.0.0", port=settings.admin_port, log_config=None)


if __name__ == "__main__":
    main()
