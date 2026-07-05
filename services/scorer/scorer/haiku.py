"""LLM adjudication for the gray-zone escalation, via the project's configured provider.

Adjudicates via the project's configured provider (Anthropic messages API or OpenAI
chat-completions), branching on ``ResolvedModeratorConfig.llm_provider``. Reuses the salvaged
``policy.build_system_prompt`` / ``build_user_prompt`` and the tolerant ``verdict.parse_verdict``,
so the verdict contract (allow/block/review + categories + confidence + reason) is identical to the
old moderator's.

``assess`` returns None when the project has no LLM configured (no ``llm_api_key``) AND on any
error (network / non-2xx / unparseable) — the caller treats None as "couldn't decide" and routes
the borderline item to the human review queue rather than failing (and redelivering) the whole job.
``llm_api_key`` is a SECRET — it is never logged (only status codes / verdicts are).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import httpx

from .config import ResolvedModeratorConfig
from .logging import get_logger, log
from .policy import build_system_prompt, build_user_prompt
from .verdict import parse_verdict

logger = get_logger("scorer.haiku")

_ANTHROPIC_VERSION = "2023-06-01"
_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_OPENAI_URL = "https://api.openai.com/v1/chat/completions"
_TIMEOUT_S = 15.0


@dataclass
class AssessResult:
    verdict: str
    categories: list[str]
    confidence: float
    reason: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0


async def assess(
    cfg: ResolvedModeratorConfig,
    text: str,
    categories: list[str],
    context: Optional[str] = None,
) -> Optional[AssessResult]:
    """Adjudicate borderline content via the project's LLM. None → disabled (no key) or errored
    (→ human queue). The API key is a secret — never logged (status/verdict only)."""
    if not cfg.llm_enabled():
        return None

    system = build_system_prompt(categories)
    user = build_user_prompt(text, context)
    if cfg.llm_provider == "openai":
        url = _OPENAI_URL
        headers = {"authorization": f"Bearer {cfg.llm_api_key}", "content-type": "application/json"}
        body = {
            "model": cfg.llm_model,
            "max_tokens": cfg.llm_max_tokens,
            "temperature": 0,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
    else:  # anthropic (default)
        url = _ANTHROPIC_URL
        headers = {
            "x-api-key": cfg.llm_api_key or "",
            "anthropic-version": _ANTHROPIC_VERSION,
            "content-type": "application/json",
        }
        body = {
            "model": cfg.llm_model,
            "max_tokens": cfg.llm_max_tokens,
            "temperature": 0,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            res = await client.post(url, json=body, headers=headers)
        if res.status_code >= 400:
            log(logger, "error", "llm non-2xx", status=res.status_code)  # no key/body/headers logged
            return None
        data = res.json()
        usage = data.get("usage") or {}
        if cfg.llm_provider == "openai":
            out_text = (((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
            prompt_tokens = int(usage.get("prompt_tokens") or 0)
            completion_tokens = int(usage.get("completion_tokens") or 0)
        else:
            out_text = next((b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"), "")
            prompt_tokens = int(usage.get("input_tokens") or 0)
            completion_tokens = int(usage.get("output_tokens") or 0)
        parsed = parse_verdict(out_text)
        return AssessResult(
            verdict=parsed.verdict,
            categories=parsed.categories,
            confidence=parsed.confidence,
            reason=parsed.reason,
            model=f"{cfg.llm_provider}:{cfg.llm_model}",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        log(logger, "error", "llm call failed; routing to human review")
        log(logger, "debug", "llm error detail", err=str(exc))
        return None
