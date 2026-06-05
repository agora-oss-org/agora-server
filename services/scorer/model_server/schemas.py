"""Request/response models for the model server."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class ScoreRequest(BaseModel):
    text: str
    context: Optional[str] = None  # accepted for parity; classifiers may ignore it


class ScoreResponse(BaseModel):
    label: str  # the top label, e.g. "toxic" / "positive"
    score: float  # 0..1 confidence in the top label
    scores: dict[str, float]  # full label → probability map
    model: str
    kind: str


class HealthResponse(BaseModel):
    status: str  # "ok"
    kind: str
    model: str
    loaded: bool
