"""Port of llm-provider.test.ts parseVerdict cases — tolerant JSON parsing."""

from __future__ import annotations

import pytest

from scorer.verdict import parse_verdict


def test_clean_json() -> None:
    v = parse_verdict('{"verdict":"block","categories":["spam"],"confidence":0.9,"reason":"x"}')
    assert v.verdict == "block"
    assert v.categories == ["spam"]
    assert v.confidence == 0.9
    assert v.reason == "x"


def test_survives_code_fences_and_prose() -> None:
    raw = 'Sure!\n```json\n{"verdict":"allow","categories":[],"confidence":0.2,"reason":"clean"}\n```\nDone.'
    v = parse_verdict(raw)
    assert v.verdict == "allow"
    assert v.confidence == 0.2


def test_unknown_verdict_defaults_to_review() -> None:
    v = parse_verdict('{"verdict":"nuke","confidence":0.5}')
    assert v.verdict == "review"


def test_confidence_is_clamped() -> None:
    assert parse_verdict('{"verdict":"block","confidence":5}').confidence == 1.0
    assert parse_verdict('{"verdict":"block","confidence":-3}').confidence == 0.0


def test_non_finite_confidence_becomes_zero() -> None:
    assert parse_verdict('{"verdict":"block","confidence":"high"}').confidence == 0.0


def test_categories_filtered_to_strings() -> None:
    v = parse_verdict('{"verdict":"block","categories":["a",1,null,"b"],"confidence":0.5}')
    assert v.categories == ["a", "b"]


def test_missing_fields_have_defaults() -> None:
    v = parse_verdict('{"verdict":"allow"}')
    assert v.categories == []
    assert v.confidence == 0.0
    assert v.reason == ""


def test_no_json_raises() -> None:
    with pytest.raises(ValueError):
        parse_verdict("totally not json")
