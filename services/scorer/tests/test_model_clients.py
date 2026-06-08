"""Model client: POST /score parsing + parallel score_both (respx-mocked, no real model server)."""

from __future__ import annotations

import dataclasses

import httpx
import respx

from scorer.config import Settings
from worker.model_clients import _post_score, score_both


@respx.mock
async def test_post_score_parses_label_and_distribution() -> None:
    respx.post("http://tox:8001/score").mock(
        return_value=httpx.Response(
            200, json={"label": "toxic", "score": 0.9, "scores": {"toxic": 0.9, "neutral": 0.1},
                       "model": "m", "kind": "toxicity"}
        )
    )
    r = await _post_score("http://tox:8001", "you are awful", None)
    assert r.label == "toxic"
    assert r.score == 0.9
    assert r.scores == {"toxic": 0.9, "neutral": 0.1}


@respx.mock
async def test_score_both_hits_both_servers() -> None:
    s = dataclasses.replace(Settings(), toxicity_url="http://tox:8001", relationship_url="http://rel:8002")
    respx.post("http://tox:8001/score").mock(
        return_value=httpx.Response(200, json={"label": "toxic", "score": 0.8, "scores": {"toxic": 0.8, "neutral": 0.2}})
    )
    respx.post("http://rel:8002/score").mock(
        return_value=httpx.Response(200, json={"label": "positive", "score": 0.7, "scores": {"positive": 0.7, "negative": 0.1}})
    )
    tox, rel = await score_both(s, "hello")
    assert tox.scores["toxic"] == 0.8
    assert rel.label == "positive"
    assert rel.scores["negative"] == 0.1
