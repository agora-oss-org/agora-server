"""Reason formatting — port of ``apps/moderator/src/lib/reason.ts``.

Formats the ``moderationReason`` written back to the API so the stored reason carries the
verdict + confidence inline, e.g. ``"AI review (60% confidence): <reason>"``. The score
travels with the decision rather than being lost.
"""

from __future__ import annotations

import math


def moderation_reason_text(verdict: str, confidence: float, reason: str | None = None) -> str:
    pct = round((confidence if math.isfinite(confidence) else 0.0) * 100)
    head = f"AI {verdict} ({pct}% confidence)"
    body = (reason or "").strip()
    return f"{head}: {body}" if body else head
