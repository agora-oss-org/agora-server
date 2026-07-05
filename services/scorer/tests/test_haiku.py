"""Haiku adjudication: request → verdict + tokens, disabled, and error-degrades-to-None."""

from __future__ import annotations

from typing import Any

import httpx
import respx

from scorer import haiku
from scorer.config import ResolvedModeratorConfig


def _cfg(**over: Any) -> ResolvedModeratorConfig:
    base = dict(block_auto_action_threshold=0.85, review_auto_action_threshold=0.0, categories=["harassment"])
    base.update(over)
    return ResolvedModeratorConfig(**base)  # type: ignore[arg-type]


@respx.mock
async def test_assess_anthropic_parses_verdict_and_tokens() -> None:
    cfg = _cfg(llm_provider="anthropic", llm_api_key="k", llm_model="claude-haiku-4-5")
    route = respx.post("https://api.anthropic.com/v1/messages").mock(
        return_value=httpx.Response(200, json={
            "content": [{"type": "text", "text": '{"verdict":"block","categories":["harassment"],"confidence":0.92,"reason":"x"}'}],
            "usage": {"input_tokens": 30, "output_tokens": 12},
        })
    )
    r = await haiku.assess(cfg, "you are awful", ["harassment"])
    assert r is not None and r.verdict == "block" and r.model == "anthropic:claude-haiku-4-5"
    assert (r.prompt_tokens, r.completion_tokens) == (30, 12)
    # anthropic auth header carries the key, NOT a Bearer token
    assert route.calls.last.request.headers.get("x-api-key") == "k"


@respx.mock
async def test_assess_openai_parses_verdict_and_tokens() -> None:
    cfg = _cfg(llm_provider="openai", llm_api_key="sk-openai", llm_model="gpt-4o-mini")
    route = respx.post("https://api.openai.com/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={
            "choices": [{"message": {"content": '{"verdict":"allow","categories":[],"confidence":0.1,"reason":"ok"}'}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 5},
        })
    )
    r = await haiku.assess(cfg, "hello", [])
    assert r is not None and r.verdict == "allow" and r.model == "openai:gpt-4o-mini"
    assert (r.prompt_tokens, r.completion_tokens) == (20, 5)
    assert route.calls.last.request.headers.get("authorization") == "Bearer sk-openai"


async def test_assess_disabled_returns_none() -> None:
    assert await haiku.assess(_cfg(llm_api_key=None), "x", []) is None


@respx.mock
async def test_assess_http_error_returns_none() -> None:
    cfg = _cfg(llm_api_key="k")
    respx.post("https://api.anthropic.com/v1/messages").mock(return_value=httpx.Response(500, json={}))
    assert await haiku.assess(cfg, "x", []) is None


@respx.mock
async def test_llm_api_key_never_logged(monkeypatch: Any) -> None:
    recorded: list = []
    monkeypatch.setattr(haiku, "log", lambda logger, level, msg, **kw: recorded.append((msg, kw)))
    cfg = _cfg(llm_provider="anthropic", llm_api_key="sk-super-secret")
    respx.post("https://api.anthropic.com/v1/messages").mock(return_value=httpx.Response(500, json={}))
    await haiku.assess(cfg, "x", [])
    assert "sk-super-secret" not in repr(recorded)
