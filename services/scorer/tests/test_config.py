"""Per-project config merge — resolve() overlays moderator_config jsonb over env defaults (pure)."""

from __future__ import annotations

import dataclasses

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


def test_resolve_applies_gray_zone_and_co_participates() -> None:
    s = Settings()
    cfg = resolve(
        {
            "grayzoneLow": 0.2, "grayzoneHigh": 0.7,
            "coParticipatesLookbackDays": 14, "coParticipatesMaxParticipants": 100,
            "coParticipatesMaxWeight": 5,
        },
        s,
    )
    assert cfg.grayzone_low == 0.2
    assert cfg.grayzone_high == 0.7
    assert cfg.co_participates_lookback_days == 14
    assert cfg.co_participates_max_participants == 100
    assert cfg.co_participates_max_weight == 5.0


def test_resolve_clamps_co_participates_ceilings() -> None:
    s = Settings()
    cfg = resolve(
        {"coParticipatesMaxParticipants": 99999, "coParticipatesLookbackDays": -5, "coParticipatesMaxWeight": 99999},
        s,
    )
    assert cfg.co_participates_max_participants == 500  # hard ceiling
    assert cfg.co_participates_lookback_days == 0       # floor
    assert cfg.co_participates_max_weight == 1000.0     # ceiling


def test_resolve_inverted_gray_zone_falls_back_to_env() -> None:
    s = Settings()
    cfg = resolve({"grayzoneLow": 0.9, "grayzoneHigh": 0.2}, s)
    assert cfg.grayzone_low == s.grayzone_low
    assert cfg.grayzone_high == s.grayzone_high


def test_resolve_gray_zone_defaults_to_env() -> None:
    s = Settings()
    cfg = resolve({}, s)
    assert cfg.grayzone_low == s.grayzone_low
    assert cfg.grayzone_high == s.grayzone_high
    assert cfg.co_participates_max_participants == s.co_participates_max_participants


def test_resolve_llm_per_project_overrides() -> None:
    s = dataclasses.replace(Settings(), anthropic_api_key="env-anthropic-key", haiku_model="claude-haiku-4-5")
    cfg = resolve(
        {"llmProvider": "openai", "llmApiKey": "sk-proj-openai", "llmModel": "gpt-4o-mini", "llmMaxTokens": 256},
        s,
    )
    assert cfg.llm_provider == "openai"
    assert cfg.llm_api_key == "sk-proj-openai"
    assert cfg.llm_model == "gpt-4o-mini"
    assert cfg.llm_max_tokens == 256
    assert cfg.llm_enabled() is True


def test_resolve_llm_falls_back_to_env_for_anthropic() -> None:
    s = dataclasses.replace(Settings(), anthropic_api_key="env-anthropic-key")
    cfg = resolve({}, s)  # no per-project llm → anthropic + env key + env model
    assert cfg.llm_provider == "anthropic"
    assert cfg.llm_api_key == "env-anthropic-key"
    assert cfg.llm_model == s.haiku_model
    assert cfg.llm_enabled() is True


def test_resolve_anthropic_own_key_overrides_env_key() -> None:
    # A project's own key wins over the Anthropic env key (cfg_key `or` env_key short-circuits).
    s = dataclasses.replace(Settings(), anthropic_api_key="env-anthropic-key")
    cfg = resolve({"llmProvider": "anthropic", "llmApiKey": "proj-own-key"}, s)
    assert cfg.llm_provider == "anthropic"
    assert cfg.llm_api_key == "proj-own-key"
    assert cfg.llm_enabled() is True


def test_resolve_openai_without_key_is_disabled_and_never_leaks_env_key() -> None:
    # The security invariant: an openai project with no own key must NOT inherit the Anthropic env key.
    s = dataclasses.replace(Settings(), anthropic_api_key="env-anthropic-key")
    cfg = resolve({"llmProvider": "openai"}, s)
    assert cfg.llm_provider == "openai"
    assert cfg.llm_api_key is None
    assert cfg.llm_enabled() is False
