"""FastAPI app for the RoBERTa model server: POST /score, GET /health, GET /info.

The model is loaded **warm on startup** (lifespan), not at import, so the module imports without
torch (keeps it testable) and the weights live in RAM for the process lifetime.
"""

from __future__ import annotations

import contextlib
from typing import AsyncIterator, Optional

from fastapi import FastAPI, HTTPException

from .classifier import Classifier
from .config import ModelServerConfig, get_config
from .schemas import HealthResponse, ScoreRequest, ScoreResponse


def create_app(config: Optional[ModelServerConfig] = None, classifier: Optional[Classifier] = None) -> FastAPI:
    cfg = config or get_config()
    state: dict[str, Optional[Classifier]] = {"clf": classifier}

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if state["clf"] is None:  # not injected (prod) → load the real model warm
            state["clf"] = Classifier(cfg)
        yield
        state["clf"] = None

    app = FastAPI(title=f"agora-scorer-model ({cfg.kind})", lifespan=lifespan)

    def _clf() -> Classifier:
        clf = state["clf"]
        if clf is None:
            raise HTTPException(status_code=503, detail={"error": "model not loaded", "code": "scorer/loading"})
        return clf

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        clf = state["clf"]
        return HealthResponse(status="ok", kind=cfg.kind, model=cfg.model, loaded=bool(clf and clf.loaded))

    @app.get("/info")
    def info() -> dict[str, object]:
        clf = state["clf"]
        return {"kind": cfg.kind, "model": cfg.model, "loaded": bool(clf and clf.loaded), "port": cfg.port}

    @app.post("/score", response_model=ScoreResponse)
    def score(req: ScoreRequest) -> ScoreResponse:
        scores = _clf().score(req.text, req.context)
        label, top = Classifier.top(scores)
        return ScoreResponse(label=label, score=top, scores=scores, model=cfg.model, kind=cfg.kind)

    return app


app = create_app()
