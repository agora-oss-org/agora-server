"""``moderation_analyses`` persistence — idempotent insert + row→envelope shaper.

PRESERVES the admin contract: the table + the ``ModerationAnalysis`` shape are unchanged from
the retired moderator (port of ``apps/moderator/src/lib/shape.ts`` ``shapeAnalysis``), and the
table stays an **append log** (one row per assessment → cumulative ``/stats`` + token metering).

IDEMPOTENCY (pgmq is at-least-once): each row is stamped with the pgmq ``source_msg_id`` and
inserted ``ON CONFLICT (source_msg_id) DO NOTHING`` (partial unique index from migration
``0028_scorer_analysis_dedup``). A redelivered job (same msg_id) is a no-op; a genuine re-score
(content edit → new pgmq message → new msg_id) inserts a new row; an on-demand ``/analyze`` row
carries ``source_msg_id = NULL`` and is unconstrained. ``analysis_exists_for_msg`` is the cheap
pre-check the consumer uses to skip re-processing (and a redundant Haiku call) on a redelivery.

STUB: the SQL (insert + queue/stats/analysis reads) is described; wired with ``scorer/db.py`` in
the implementation pass.
"""

from __future__ import annotations

from dataclasses import dataclass

from scorer.config import Settings
from scorer.logging import get_logger, log
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
    """Append one analysis row, deduped on the pgmq message id.

    STUB: INSERT INTO moderation_analyses (..., source_msg_id) VALUES (...)
          ON CONFLICT (source_msg_id) DO NOTHING;
    (wired with db.py). The ON CONFLICT makes a redelivered job a no-op.
    """
    log(
        logger,
        "info",
        "record moderation_analyses (stub)",
        target_type=data.target_type,
        target_id=data.target_id,
        verdict=data.verdict,
        confidence=data.confidence,
        auto_actioned=data.auto_actioned,
        source_msg_id=data.source_msg_id,
    )


async def analysis_exists_for_msg(settings: Settings, source_msg_id: int) -> bool:
    """Cheap pre-check: has this pgmq message already been recorded? (redelivery dedup).

    STUB: SELECT 1 FROM moderation_analyses WHERE source_msg_id = $1 LIMIT 1. Returns False until
    db.py is wired (so the foundation never skips work).
    """
    log(logger, "debug", "analysis_exists_for_msg (stub)", source_msg_id=source_msg_id)
    return False


def shape_analysis(row: dict[str, object]) -> ModerationAnalysis:
    """Row → ModerationAnalysis envelope (camelCase, Date→ISO). Port of shape.ts shapeAnalysis."""
    # TODO(scorer): map DB row columns to the model; stubbed passthrough for the foundation.
    return ModerationAnalysis(**row)  # type: ignore[arg-type]
