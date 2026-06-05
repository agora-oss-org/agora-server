"""Tolerant verdict parsing — port of ``parseVerdict`` from ``apps/moderator/src/lib/llm-provider.ts``.

Strips code fences, isolates the first ``{...}`` object (so we survive stray prose), parses
tolerantly, normalizes an unknown verdict to "review", filters categories to strings, and
clamps confidence to 0..1. Pure + unit-tested (``tests/test_verdict.py``).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Literal

ModerationVerdict = Literal["allow", "block", "review"]
_VERDICTS: tuple[ModerationVerdict, ...] = ("allow", "block", "review")
_FENCE_JSON = re.compile(r"```json", re.IGNORECASE)


@dataclass
class ParsedVerdict:
    verdict: ModerationVerdict
    categories: list[str] = field(default_factory=list)
    confidence: float = 0.0
    reason: str = ""


def parse_verdict(raw: str) -> ParsedVerdict:
    """Parse a model's raw text into a normalized verdict. Raises ValueError if no JSON object."""
    cleaned = _FENCE_JSON.sub("", raw).replace("```", "").strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"LLM output not JSON: {raw[:200]}")
    try:
        obj = json.loads(cleaned[start : end + 1])
    except (ValueError, TypeError) as exc:
        raise ValueError(f"LLM output not parseable JSON: {raw[:200]}") from exc
    if not isinstance(obj, dict):
        raise ValueError(f"LLM output not a JSON object: {raw[:200]}")

    verdict = obj.get("verdict")
    verdict = verdict if verdict in _VERDICTS else "review"

    raw_categories = obj.get("categories")
    categories = (
        [c for c in raw_categories if isinstance(c, str)]
        if isinstance(raw_categories, list)
        else []
    )

    confidence = obj.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not math.isfinite(confidence):
        confidence = 0.0
    confidence = min(1.0, max(0.0, float(confidence)))

    reason = obj.get("reason")
    reason = reason if isinstance(reason, str) else ""

    return ParsedVerdict(verdict=verdict, categories=categories, confidence=confidence, reason=reason)
