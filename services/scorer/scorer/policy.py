"""The moderation policy — VERBATIM port of ``apps/moderator/src/lib/policy.ts``.

The system prompt pins the LLM (now Claude Haiku, via ``scorer/haiku.py``) to a strict
JSON contract; kept separate from transport so it can be tuned and unit-tested in
isolation. Categories are per-project: the starting list is ``DEFAULT_MODERATION_CATEGORIES``
(seeded into ``projects.moderator_config.categories`` and editable in admin Settings →
Agent moderation). ``scorer/config.py`` resolves the project's list and passes it to
``build_system_prompt``.

verdict semantics:
  allow  — clean / within policy
  block  — clearly violates policy (eligible for auto-removal above the confidence threshold)
  review — uncertain or context-dependent; always routes to a human

NOTE: ``DEFAULT_MODERATION_CATEGORIES`` lives in ``@agora/contract`` on the TS side. There
is no Python build of the contract, so the list is mirrored here. If the contract's default
taxonomy changes, update this constant to match (covered by ``tests/test_policy.py``).
"""

from __future__ import annotations

from collections.abc import Sequence

# Mirror of @agora/contract DEFAULT_MODERATION_CATEGORIES. Keep in sync with the contract.
# TODO(scorer): confirm this list against packages/contract once the worker is wired; the
# values below are the documented moderation taxonomy categories.
DEFAULT_MODERATION_CATEGORIES: tuple[str, ...] = (
    "harassment",
    "hate",
    "self-harm",
    "sexual",
    "sexual/minors",
    "violence",
    "spam",
    "illegal",
)


def build_system_prompt(categories: Sequence[str]) -> str:
    """Build the classifier system prompt for the given per-project category list."""
    chosen = list(categories) if categories else list(DEFAULT_MODERATION_CATEGORIES)
    list_str = ", ".join(chosen)
    return (
        "You are a content-moderation classifier for an online community.\n"
        "Judge the USER content against this policy and respond with a SINGLE JSON object — no markdown, no\n"
        "prose, no code fences.\n"
        "\n"
        f"Categories: {list_str}.\n"
        "\n"
        "Output schema (all fields required):\n"
        "{\n"
        '  "verdict": "allow" | "block" | "review",\n'
        '  "categories": string[],   // subset of the categories above; [] when verdict is "allow"\n'
        '  "confidence": number,     // 0..1, your certainty in the verdict\n'
        '  "reason": string          // one concise sentence explaining the decision\n'
        "}\n"
        "\n"
        "Rules:\n"
        '- "block" only when the content clearly violates policy. Use "review" when it is borderline,\n'
        "  sarcastic, ambiguous, or depends on context you lack.\n"
        '- Any sexual content involving minors is always "block" with confidence 1.\n'
        "- Do not moralize or add commentary. Output ONLY the JSON object."
    )


def build_user_prompt(text: str, context: str | None = None) -> str:
    """Build the user-message body. ``context`` (e.g. the parent entity) is optional."""
    ctx = (context or "").strip()
    if ctx:
        return (
            "CONTEXT (the content this is replying to, for reference only — do not moderate it):\n"
            f"{ctx}\n\nCONTENT TO MODERATE:\n{text}"
        )
    return f"CONTENT TO MODERATE:\n{text}"
