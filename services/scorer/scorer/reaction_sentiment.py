"""Reaction type → signed relationship sentiment in [-1, 1].

Reactions carry no text, so the relationship classifier can't score them — their warmth toward the
recipient is derived from the reaction TYPE alone. Pure + tested. An unknown/future type maps to 0.0
(neutral) rather than erroring. See docs/SCORER.md → "The relationship graph" (v2) and the design spec
(docs/superpowers/specs/2026-06-08-relationship-graph-v2-design.md).
"""

from __future__ import annotations

# Taxonomy mirrors the reaction_type enum (apps/api/src/db/schema/_shared.ts):
#   upvote, downvote, like, love, wow, sad, angry, funny
# `sad` is left neutral — it reads as empathy as often as disapproval; we don't claim a sign.
_REACTION_SENTIMENT: dict[str, float] = {
    "upvote": 1.0,
    "love": 1.0,
    "like": 0.8,
    "funny": 0.5,
    "wow": 0.3,
    "sad": 0.0,
    "angry": -0.8,
    "downvote": -1.0,
}


def reaction_sentiment(reaction_type: str) -> float:
    """Signed warmth in [-1, 1] for a reaction type; 0.0 for an unknown/future type."""
    return _REACTION_SENTIMENT.get(reaction_type, 0.0)
