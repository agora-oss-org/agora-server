"""Per-project config merge — resolve() overlays moderator_config jsonb over env defaults (pure)."""

from __future__ import annotations

from scorer.config import Settings, resolve
from scorer.policy import DEFAULT_MODERATION_CATEGORIES


def test_resolve_falls_back_to_env_defaults() -> None:
    s = Settings()
    cfg = resolve({}, s)
    assert cfg.block_auto_action_threshold == s.block_auto_action_threshold
    assert cfg.review_auto_action_threshold == s.review_auto_action_threshold
    assert cfg.categories == list(DEFAULT_MODERATION_CATEGORIES)


def test_resolve_applies_and_clamps_overrides() -> None:
    s = Settings()
    cfg = resolve(
        {"blockAutoActionThreshold": 0.5, "reviewAutoActionThreshold": 5, "categories": ["a", " b ", 3, ""]},
        s,
    )
    assert cfg.block_auto_action_threshold == 0.5
    assert cfg.review_auto_action_threshold == 1.0  # clamped to 0..1
    assert cfg.categories == ["a", "b"]  # stripped; non-strings + blanks dropped


def test_resolve_ignores_bad_threshold_types() -> None:
    s = Settings()
    cfg = resolve({"blockAutoActionThreshold": "high"}, s)
    assert cfg.block_auto_action_threshold == s.block_auto_action_threshold


def test_resolve_empty_categories_falls_back() -> None:
    s = Settings()
    assert resolve({"categories": []}, s).categories == list(DEFAULT_MODERATION_CATEGORIES)


def test_co_participates_defaults() -> None:
    s = Settings()
    assert s.co_participates_lookback_days == 7
    assert s.co_participates_max_participants == 50
    assert s.co_participates_max_weight == 10.0
