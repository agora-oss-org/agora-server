"""FastAPI app for the RoBERTa model server: POST /score, GET /health, GET /info."""

from __future__ import annotations

from fastapi import FastAPI

from .classifier import Classifier
from .config import get_config
from .schemas import HealthResponse, ScoreRequest, ScoreResponse


def create_app() -> FastAPI:
    config = get_config()
    classifier = Classifier(config)
    app = FastAPI(title=f"agora-scorer-model ({config.kind})")

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        # 200 even while stubbed (loaded=False) so compose/k8s probes pass during the foundation.
        return HealthResponse(status="ok", kind=config.kind, model=config.model, loaded=classifier.loaded)

    @app.get("/info")
    def info() -> dict[str, object]:
        return {"kind": config.kind, "model": config.model, "loaded": classifier.loaded, "port": config.port}

    @app.post("/score", response_model=ScoreResponse)
    def score(req: ScoreRequest) -> ScoreResponse:
        scores = classifier.score(req.text, req.context)
        label, top = Classifier.top(scores)
        return ScoreResponse(label=label, score=top, scores=scores, model=config.model, kind=config.kind)

    return app


app = create_app()
