"""Async HTTP clients for the two RoBERTa model servers.

The worker calls toxicity + relationship IN PARALLEL (``asyncio.gather``) so total latency is
``max(t_tox, t_rel)`` rather than the sum — see ``pipeline.py``. Each ``/score`` returns
``{label, score, scores, model, kind}``; we keep the full ``scores`` distribution (the pipeline gates
on ``P(toxic)`` and derives the signed relationship quality from it).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx

from scorer.config import Settings

_TIMEOUT_S = 10.0


@dataclass
class ModelScore:
    label: str
    score: float
    scores: dict[str, float]


async def _post_score(url: str, text: str, context: str | None) -> ModelScore:
    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        res = await client.post(f"{url}/score", json={"text": text, "context": context})
        res.raise_for_status()
        data = res.json()
    return ModelScore(
        label=str(data["label"]),
        score=float(data["score"]),
        scores={str(k): float(v) for k, v in (data.get("scores") or {}).items()},
    )


async def score_both(settings: Settings, text: str, context: str | None = None) -> tuple[ModelScore, ModelScore]:
    """Call the toxicity + relationship model servers concurrently."""
    toxicity, relationship = await asyncio.gather(
        _post_score(settings.toxicity_url, text, context),
        _post_score(settings.relationship_url, text, context),
    )
    return toxicity, relationship
