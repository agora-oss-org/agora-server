"""Claude Haiku adjudication for the gray-zone escalation.

Replaces the moderator's generic OpenAI/Anthropic adapter with a Haiku-specific client. It
reuses the salvaged ``policy.build_system_prompt`` / ``build_user_prompt`` and the tolerant
``verdict.parse_verdict``, so the verdict contract (allow/block/review + categories +
confidence + reason) is identical to the old moderator's. POSTs to Anthropic ``/v1/messages``
(``anthropic-version: 2023-06-01``), ``temperature: 0``.

STUB: the HTTP call is sketched with the exact request shape but left unwired (no httpx call)
for the foundation pass; ``assess()`` returns None when the key is unset (escalation disabled).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .config import Settings
from .logging import get_logger, log
from .policy import build_system_prompt, build_user_prompt
from .verdict import ParsedVerdict, parse_verdict

logger = get_logger("scorer.haiku")

_ANTHROPIC_VERSION = "2023-06-01"


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
    """Run the policy classifier over content via Claude Haiku.

    Returns None when Haiku is not configured (no ``ANTHROPIC_API_KEY``) → caller records the
    RoBERTa score only and routes borderline items to the human queue.

    STUB: builds the prompts + request shape but does not perform the HTTP call yet.
    """
    if not settings.haiku_enabled():
        return None

    system = build_system_prompt(categories)
    user = build_user_prompt(text, context)
    # The request we WILL send (wired in the implementation pass):
    #   POST {anthropic}/v1/messages
    #   headers: x-api-key, anthropic-version, content-type
    #   body: {model, max_tokens, temperature:0, system, messages:[{role:"user", content:user}]}
    _request_body = {
        "model": settings.haiku_model,
        "max_tokens": settings.haiku_max_tokens,
        "temperature": 0,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    log(logger, "debug", "haiku.assess (stub)", model=settings.haiku_model, prompt_chars=len(user))
    # TODO(scorer): perform httpx POST, then:
    #   parsed = parse_verdict(response_text)
    #   return AssessResult(**parsed, model=f"anthropic:{settings.haiku_model}", tokens...)
    _ = ParsedVerdict  # referenced for the wiring contract
    raise NotImplementedError("haiku.assess HTTP call not wired in the foundation pass")
