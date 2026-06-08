"""The auto-action decision — VERBATIM port of ``apps/moderator/src/lib/auto-action.ts``.

Given an LLM verdict + confidence and a project's two confidence floors, decide whether to
auto-remove the content and which verdict triggered it. Pure (no DB, no LLM) so the decision
table is unit-tested in isolation (``tests/test_auto_action.py``).

Two independent floors let an operator tune block and review separately:
  - block_auto_action_threshold  — auto-remove a "block" verdict at/above this confidence
  - review_auto_action_threshold — auto-remove a "review" verdict at/above this confidence
A floor of 0 disables that path entirely (the verdict routes to the human AI-flag queue).
Only entity/comment are scored + removable through the API write-back (chat is end-to-end-encrypted
secure chat — never scored); the `removable` guard stays as defense-in-depth.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

ModerationVerdict = Literal["allow", "block", "review"]
ReportTargetType = Literal["entity", "comment"]
# Which floor fired — surfaced in the verdict log + carried into the write-back reason; None = queue.
AutoActionTrigger = Optional[Literal["block", "review"]]


@dataclass(frozen=True)
class AutoActionThresholds:
    block_auto_action_threshold: float
    review_auto_action_threshold: float


def decide_auto_action(
    verdict: ModerationVerdict,
    confidence: float,
    target_type: ReportTargetType,
    thresholds: AutoActionThresholds,
) -> AutoActionTrigger:
    removable = target_type in ("entity", "comment")
    if not removable:
        return None
    if (
        verdict == "block"
        and thresholds.block_auto_action_threshold > 0
        and confidence >= thresholds.block_auto_action_threshold
    ):
        return "block"
    if (
        verdict == "review"
        and thresholds.review_auto_action_threshold > 0
        and confidence >= thresholds.review_auto_action_threshold
    ):
        return "review"
    return None
