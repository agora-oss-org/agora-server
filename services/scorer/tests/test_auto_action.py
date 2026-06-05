"""Port of auto-action.test.ts — the decision table."""

from __future__ import annotations

import pytest

from scorer.auto_action import AutoActionThresholds, decide_auto_action

T = AutoActionThresholds(block_auto_action_threshold=0.85, review_auto_action_threshold=0.6)


def test_block_at_or_above_threshold_triggers() -> None:
    assert decide_auto_action("block", 0.85, "entity", T) == "block"
    assert decide_auto_action("block", 0.99, "comment", T) == "block"


def test_block_below_threshold_queues() -> None:
    assert decide_auto_action("block", 0.84, "entity", T) is None


def test_review_at_or_above_threshold_triggers() -> None:
    assert decide_auto_action("review", 0.6, "entity", T) == "review"


def test_review_below_threshold_queues() -> None:
    assert decide_auto_action("review", 0.59, "entity", T) is None


def test_zero_threshold_disables_path() -> None:
    z = AutoActionThresholds(block_auto_action_threshold=0.0, review_auto_action_threshold=0.0)
    assert decide_auto_action("block", 1.0, "entity", z) is None
    assert decide_auto_action("review", 1.0, "entity", z) is None


def test_allow_never_triggers() -> None:
    assert decide_auto_action("allow", 1.0, "entity", T) is None


@pytest.mark.parametrize("target", ["message"])
def test_non_removable_targets_always_queue(target: str) -> None:
    assert decide_auto_action("block", 1.0, target, T) is None  # type: ignore[arg-type]
