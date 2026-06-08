"""Claude Haiku adjudication for the gray-zone escalation.

Replaces the moderator's generic OpenAI/Anthropic adapter with a Haiku-specific client. Reuses the
salvaged ``policy.build_system_prompt`` / ``build_user_prompt`` and the tolerant
``verdict.parse_verdict``, so the verdict contract (allow/block/review + categories + confidence +
reason) is identical to the old moderator's. POSTs to Anthropic ``/v1/messages``
(``anthropic-version: 2023-06-01``, ``temperature: 0``).

``assess`` returns None when Haiku isn't configured (no ``ANTHROPIC_API_KEY``) AND on any error
(network / non-2xx / unparseable) — the caller treats None as "couldn't decide" and routes the
borderline item to the human review queue rather than failing (and redelivering) the whole job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import httpx

from .config import Settings
from .logging import get_logger, log
from .policy import build_system_prompt, build_user_prompt
from .verdict import parse_verdict

logger = get_logger("scorer.haiku")

_ANTHROPIC_VERSION = "2023-06-01"
_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
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
    settings: Settings,
    text: str,
    categories: list[str],
    context: Optional[str] = None,
) -> Optional[AssessResult]:
    """Adjudicate borderline content via Claude Haiku. None → disabled or errored (→ human queue)."""
    if not settings.haiku_enabled():
        return None

    body = {
        "model": settings.haiku_model,
        "max_tokens": settings.haiku_max_tokens,
        "temperature": 0,
        "system": build_system_prompt(categories),
        "messages": [{"role": "user", "content": build_user_prompt(text, context)}],
    }
    headers = {
        "x-api-key": settings.anthropic_api_key or "",
        "anthropic-version": _ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            res = await client.post(_ANTHROPIC_URL, json=body, headers=headers)
        if res.status_code >= 400:
            log(logger, "error", "haiku non-2xx", status=res.status_code)
            return None
        data = res.json()
        out_text = next((b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"), "")
        parsed = parse_verdict(out_text)
        usage = data.get("usage") or {}
        return AssessResult(
            verdict=parsed.verdict,
            categories=parsed.categories,
            confidence=parsed.confidence,
            reason=parsed.reason,
            model=f"anthropic:{settings.haiku_model}",
            prompt_tokens=int(usage.get("input_tokens") or 0),
            completion_tokens=int(usage.get("output_tokens") or 0),
        )
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        log(logger, "error", "haiku call failed; routing to human review")
        log(logger, "debug", "haiku error detail", err=str(exc))
        return None
