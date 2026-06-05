"""Port of policy.test.ts — assert the prompt + verdict schema match the salvaged contract."""

from __future__ import annotations

from scorer.policy import DEFAULT_MODERATION_CATEGORIES, build_system_prompt, build_user_prompt


def test_system_prompt_lists_given_categories() -> None:
    prompt = build_system_prompt(["spam", "abuse"])
    assert "Categories: spam, abuse." in prompt
    # The strict JSON contract is pinned.
    assert '"verdict": "allow" | "block" | "review"' in prompt
    assert '"confidence": number' in prompt
    assert "Output ONLY the JSON object." in prompt


def test_system_prompt_falls_back_to_defaults_when_empty() -> None:
    prompt = build_system_prompt([])
    assert ", ".join(DEFAULT_MODERATION_CATEGORIES) in prompt


def test_user_prompt_without_context() -> None:
    assert build_user_prompt("hello") == "CONTENT TO MODERATE:\nhello"


def test_user_prompt_with_context() -> None:
    out = build_user_prompt("hello", "the parent post")
    assert "CONTEXT (the content this is replying to" in out
    assert "the parent post" in out
    assert out.endswith("CONTENT TO MODERATE:\nhello")


def test_user_prompt_blank_context_is_ignored() -> None:
    assert build_user_prompt("hi", "   ") == "CONTENT TO MODERATE:\nhi"
