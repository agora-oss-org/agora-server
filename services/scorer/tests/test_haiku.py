"""Haiku adjudication: request → verdict + tokens, disabled, and error-degrades-to-None."""

from __future__ import annotations

import dataclasses
from typing import Any

import httpx
import respx

from scorer import haiku
from scorer.config import Settings


def _settings(**over: Any) -> Settings:
    return dataclasses.replace(Settings(), **over)


@respx.mock
async def test_assess_parses_verdict_and_tokens() -> None:
    s = _settings(anthropic_api_key="k", haiku_model="claude-haiku-4-5")
    respx.post("https://api.anthropic.com/v1/messages").mock(
        return_value=httpx.Response(
            200,
            json={
                "content": [
                    {"type": "text", "text": '{"verdict":"block","categories":["harassment"],"confidence":0.92,"reason":"x"}'}
                ],
                "usage": {"input_tokens": 30, "output_tokens": 12},
            },
        )
    )
    r = await haiku.assess(s, "you are awful", ["harassment"])
    assert r is not None
    assert r.verdict == "block"
    assert r.categories == ["harassment"]
    assert r.confidence == 0.92
    assert r.model == "anthropic:claude-haiku-4-5"
    assert (r.prompt_tokens, r.completion_tokens) == (30, 12)


async def test_assess_disabled_returns_none() -> None:
    assert await haiku.assess(_settings(anthropic_api_key=None), "x", []) is None


@respx.mock
async def test_assess_http_error_returns_none() -> None:
    s = _settings(anthropic_api_key="k")
    respx.post("https://api.anthropic.com/v1/messages").mock(return_value=httpx.Response(500, json={}))
    assert await haiku.assess(s, "x", []) is None
