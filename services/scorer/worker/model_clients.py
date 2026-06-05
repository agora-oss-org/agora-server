"""Async HTTP clients for the two RoBERTa model servers.

The worker calls toxicity + relationship IN PARALLEL (``asyncio.gather``) so total latency is
``max(t_tox, t_rel)`` rather than the sum — see ``pipeline.py``.

STUB: the httpx POST is sketched; returns placeholder scores until wired.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from scorer.config import Settings
from scorer.logging import get_logger, log

logger = get_logger("scorer.worker.model_clients")


@dataclass
class ModelScore:
    label: str
    score: float
    scores: dict[str, float]


async def _post_score(url: str, text: str, context: str | None) -> ModelScore:
    # TODO(scorer): async with httpx.AsyncClient() as c:
    #   r = await c.post(f"{url}/score", json={"text": text, "context": context}, timeout=5)
    #   data = r.json(); return ModelScore(data["label"], data["score"], data["scores"])
    log(logger, "debug", "model POST /score (stub)", url=url)
    return ModelScore(label="stub", score=0.0, scores={})


async def score_both(settings: Settings, text: str, context: str | None = None) -> tuple[ModelScore, ModelScore]:
    """Call toxicity + relationship model servers concurrently."""
    toxicity, relationship = await asyncio.gather(
        _post_score(settings.toxicity_url, text, context),
        _post_score(settings.relationship_url, text, context),
    )
    return toxicity, relationship
