"""``moderation_analyses`` persistence — idempotent upsert + row→envelope shaper.

PRESERVES the admin contract: the table + the ``ModerationAnalysis`` shape are unchanged from
the retired moderator (port of ``apps/moderator/src/lib/shape.ts`` ``shapeAnalysis``). Because
pgmq is at-least-once, the upsert must be IDEMPOTENT — keyed so a redelivered job updates the
same logical analysis rather than inserting a duplicate.

STUB: the SQL (insert/upsert + queue/stats/analysis reads) is described; wired with
``scorer/db.py`` in the implementation pass.
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


async def upsert_analysis(settings: Settings, data: AnalysisInput) -> None:
    """Idempotently record one analysis row.

    STUB: INSERT INTO moderation_analyses (...) — idempotency strategy (e.g. ON CONFLICT on a
    natural key, or delete-latest-then-insert) is finalized when db.py is wired.
    """
    log(
        logger,
        "info",
        "upsert moderation_analyses (stub)",
        target_type=data.target_type,
        target_id=data.target_id,
        verdict=data.verdict,
        confidence=data.confidence,
        auto_actioned=data.auto_actioned,
    )


def shape_analysis(row: dict[str, object]) -> ModerationAnalysis:
    """Row → ModerationAnalysis envelope (camelCase, Date→ISO). Port of shape.ts shapeAnalysis."""
    # TODO(scorer): map DB row columns to the model; stubbed passthrough for the foundation.
    return ModerationAnalysis(**row)  # type: ignore[arg-type]
