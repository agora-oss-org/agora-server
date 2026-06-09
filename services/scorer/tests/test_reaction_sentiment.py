"""The reaction-type → signed-sentiment map (pure)."""

from __future__ import annotations

import pytest

from scorer.reaction_sentiment import reaction_sentiment


@pytest.mark.parametrize(
    ("reaction_type", "expected"),
    [
        ("upvote", 1.0),
        ("love", 1.0),
        ("like", 0.8),
        ("funny", 0.5),
        ("wow", 0.3),
        ("sad", 0.0),
        ("angry", -0.8),
        ("downvote", -1.0),
    ],
)
def test_known_reaction_types_map_to_signed_sentiment(reaction_type: str, expected: float) -> None:
    assert reaction_sentiment(reaction_type) == expected


def test_unknown_reaction_type_is_neutral() -> None:
    # A future/unrecognized reaction type must degrade to neutral, never raise.
    assert reaction_sentiment("partyparrot") == 0.0
    assert reaction_sentiment("") == 0.0


def test_all_values_are_within_unit_range() -> None:
    for rt in ("upvote", "love", "like", "funny", "wow", "sad", "angry", "downvote"):
        assert -1.0 <= reaction_sentiment(rt) <= 1.0
