"""Persistence seam for the raw classifier signals — AnalysisInput → insert passthrough and the
row → ModerationAnalysis shaper (None-safe for pre-0056 rows)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from scorer import db
from scorer.config import Settings
from worker import analyses
from worker.analyses import AnalysisInput


def _input(**overrides: Any) -> AnalysisInput:
    base: dict[str, Any] = dict(
        project_id="p1", target_type="entity", target_id="t1", space_id=None,
        verdict="allow", categories=[], confidence=0.05, reason="", model="roberta:toxicity",
        auto_actioned=False, toxicity_score=0.05, relationship_score=-0.6, source_msg_id=7,
    )
    base.update(overrides)
    return AnalysisInput(**base)


async def test_record_analysis_passes_raw_signals_to_insert(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    async def fake_insert(settings: Settings, **kw: Any) -> dict[str, Any]:
        captured.update(kw)
        return kw

    monkeypatch.setattr(db, "insert_analysis", fake_insert)
    await analyses.record_analysis(Settings(), _input())
    assert captured["toxicity_score"] == pytest.approx(0.05)
    assert captured["relationship_score"] == pytest.approx(-0.6)


def _row(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "a1", "project_id": "p1", "target_type": "entity", "target_id": "t1",
        "space_id": None, "verdict": "allow", "categories": [], "confidence": 0.05,
        "reason": "", "model": "roberta:toxicity", "auto_actioned": False,
        "toxicity_score": 0.05, "relationship_score": -0.6,
        "human_resolved_at": None, "created_at": datetime(2026, 7, 5, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return base


def test_shape_analysis_includes_raw_signals() -> None:
    shaped = analyses.shape_analysis(_row())
    assert shaped.toxicity_score == pytest.approx(0.05)
    assert shaped.relationship_score == pytest.approx(-0.6)
    dumped = shaped.model_dump(by_alias=True)
    assert dumped["toxicityScore"] == pytest.approx(0.05)
    assert dumped["relationshipScore"] == pytest.approx(-0.6)


def test_shape_analysis_none_safe_for_pre_migration_rows() -> None:
    shaped = analyses.shape_analysis(_row(toxicity_score=None, relationship_score=None))
    assert shaped.toxicity_score is None
    assert shaped.relationship_score is None
