"""``moderation_analyses`` persistence — deduped append + row→envelope shaper.

PRESERVES the admin contract: the table + the ``ModerationAnalysis`` shape are unchanged from the
retired moderator (port of ``apps/moderator/src/lib/shape.ts`` ``shapeAnalysis``), and the table stays
an **append log** (one row per assessment → cumulative ``/stats`` + token metering).

IDEMPOTENCY (pgmq is at-least-once): each row is stamped with the pgmq ``source_msg_id`` and inserted
``ON CONFLICT (source_msg_id) DO NOTHING`` (partial unique index from migration
``0028_scorer_analysis_dedup``). A redelivered job (same msg_id) is a no-op; a genuine re-score (content
edit → new pgmq message → new msg_id) inserts a new row; an on-demand ``/analyze`` row carries
``source_msg_id = NULL`` and is unconstrained. ``analysis_exists_for_msg`` is the cheap pre-check the
consumer uses to skip re-processing (and a redundant Haiku call) on a redelivery.

The actual SQL lives in ``scorer/db.py``; this module is the worker-facing seam (the ``AnalysisInput``
record + the row shaper).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from scorer import db
from scorer.config import Settings
from scorer.logging import get_logger
from scorer.models import ModerationAnalysis

logger = get_logger("scorer.worker.analyses")


@dataclass
class AnalysisInput:
    project_id: str
    target_type: str
    target_id: str
    space_id: str | None
    verdict: str
    categories: list[str]
    confidence: float
    reason: str
    model: str
    auto_actioned: bool
    prompt_tokens: int = 0
    completion_tokens: int = 0
    # The pgmq message id this assessment came from; None for on-demand /analyze. Dedup key.
    source_msg_id: int | None = None


async def record_analysis(settings: Settings, data: AnalysisInput) -> None:
    """Append one analysis row, deduped on the pgmq message id (ON CONFLICT DO NOTHING)."""
    await db.insert_analysis(
        settings,
        project_id=data.project_id,
        target_type=data.target_type,
        target_id=data.target_id,
        space_id=data.space_id,
        verdict=data.verdict,
        categories=data.categories,
        confidence=data.confidence,
        reason=data.reason,
        model=data.model,
        auto_actioned=data.auto_actioned,
        prompt_tokens=data.prompt_tokens,
        completion_tokens=data.completion_tokens,
        source_msg_id=data.source_msg_id,
    )


async def analysis_exists_for_msg(settings: Settings, source_msg_id: int) -> bool:
    """Cheap pre-check: has this pgmq message already been recorded? (redelivery dedup)."""
    return await db.analysis_exists_for_msg(settings, source_msg_id)


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if value is not None else None


def shape_analysis(row: Any) -> ModerationAnalysis:
    """asyncpg row → ModerationAnalysis envelope (camelCase out, Date→ISO). shape.ts shapeAnalysis.

    ``author`` is left None for now — resolving the target's author (entity/comment/message → profile)
    is a batched display enrichment deferred to a follow-up; the contract field is optional.
    """
    space_id = row["space_id"]
    return ModerationAnalysis(
        id=str(row["id"]),
        project_id=str(row["project_id"]),
        target_type=row["target_type"],
        target_id=str(row["target_id"]),
        space_id=str(space_id) if space_id is not None else None,
        verdict=row["verdict"],
        categories=list(row["categories"] or []),
        confidence=float(row["confidence"]),
        reason=row["reason"] or "",
        model=row["model"] or "",
        auto_actioned=bool(row["auto_actioned"]),
        human_resolved_at=_iso(row["human_resolved_at"]),
        created_at=_iso(row["created_at"]) or "",
        author=None,
    )
