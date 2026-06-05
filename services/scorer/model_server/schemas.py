"""Request/response models for the model server."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict

# These responses carry a legit `model` field (the HF model id) → opt out of pydantic's `model_` guard.
_CFG = ConfigDict(protected_namespaces=())


class ScoreRequest(BaseModel):
    text: str
    context: Optional[str] = None  # accepted for parity; classifiers may ignore it


class ScoreResponse(BaseModel):
    model_config = _CFG
    label: str  # the top label, e.g. "toxic" / "positive"
    score: float  # 0..1 confidence in the top label
    scores: dict[str, float]  # full label → probability map
    model: str
    kind: str


class HealthResponse(BaseModel):
    model_config = _CFG
    status: str  # "ok"
    kind: str
    model: str
    loaded: bool
