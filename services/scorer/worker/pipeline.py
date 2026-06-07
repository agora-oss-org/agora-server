"""The cascade — the heart of the worker. Shape-port of ``apps/moderator/src/lib/assess-and-record.ts``.

``assess_and_record`` is the reusable core (given the text): score both models in parallel → gray-zone
gate on **P(toxic)** → escalate borderline to Claude Haiku → decide auto-action → write-back removal
(entity/comment only) → record the (deduped) ``moderation_analyses`` row → MERGE the Neo4j relationship
edge → return the inserted row. ``process_job`` fetches the content text by id then calls the core (with
the pgmq ``msg_id`` for dedup); the admin ``/analyze`` endpoint calls the core with operator-provided text
(no pgmq message → ``source_msg_id=None``).
"""

from __future__ import annotations

from typing import Optional, cast

import asyncpg

from scorer.auto_action import AutoActionThresholds, ModerationVerdict, ReportTargetType, decide_auto_action
from scorer.config import Settings
from scorer.db import fetch_content, get_moderator_config
from scorer.haiku import assess as haiku_assess
from scorer.logging import get_logger, log
from scorer.models import ScoreJob
from scorer.reason import moderation_reason_text

from . import analyses, model_clients, neo4j_writer, writeback

logger = get_logger("scorer.worker.pipeline")


async def assess_and_record(
    settings: Settings,
    *,
    project_id: str,
    target_type: str,
    target_id: str,
    space_id: Optional[str],
    text: str,
    context: Optional[str] = None,
    author_id: Optional[str] = None,
    source_msg_id: Optional[int] = None,
) -> Optional[asyncpg.Record]:
    """Run the full cascade over ``text`` and record one analysis. Returns the inserted row (None on a
    dedup conflict). Idempotent: the insert dedups on ``source_msg_id``; write-back + MERGE are idempotent."""
    toxicity, relationship = await model_clients.score_both(settings, text, context)
    cfg = await get_moderator_config(settings, project_id)

    # ── gray-zone cascade (gate on P(toxic), not the top label) ─────────────────
    tox = toxicity.scores.get("toxic", toxicity.score)
    verdict, categories, confidence, reason, model = "allow", [], tox, "", "roberta:toxicity"
    prompt_tokens = completion_tokens = 0
    if tox >= settings.grayzone_high:
        verdict, confidence, reason = "block", tox, "High toxicity score"
    elif tox >= settings.grayzone_low:
        result = await haiku_assess(settings, text, cfg.categories, context) if settings.haiku_enabled() else None
        if result is not None:
            verdict, categories, confidence, reason = result.verdict, result.categories, result.confidence, result.reason
            model = result.model
            prompt_tokens, completion_tokens = result.prompt_tokens, result.completion_tokens
        else:
            verdict, confidence, reason = "review", tox, "Borderline toxicity; queued for human review"

    # ── decide + apply auto-action (entity/comment only) ───────────────────────
    trigger = decide_auto_action(
        cast(ModerationVerdict, verdict), confidence, cast(ReportTargetType, target_type),
        AutoActionThresholds(cfg.block_auto_action_threshold, cfg.review_auto_action_threshold),
    )
    auto_actioned = False
    if trigger is not None and target_type in ("entity", "comment"):
        auto_actioned = await writeback.apply_moderation(
            settings,
            project_id=project_id,
            target_type=target_type,  # type: ignore[arg-type]
            target_id=target_id,
            status="removed",
            reason=moderation_reason_text(verdict, confidence, reason),
        )

    # ── record the audit row (admin queue source), deduped on the pgmq msg_id ───
    row = await analyses.record_analysis(
        settings,
        analyses.AnalysisInput(
            project_id=project_id,
            target_type=target_type,
            target_id=target_id,
            space_id=space_id,
            verdict=verdict,
            categories=categories,
            confidence=confidence,
            reason=reason,
            model=model,
            auto_actioned=auto_actioned,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            source_msg_id=source_msg_id,
        ),
    )

    # ── relationship edge → Neo4j ──────────────────────────────────────────────
    # Signed quality in [-1, 1] (P(positive) - P(negative)); fall back to top score for non-sentiment models.
    rel = relationship.scores
    rel_quality = (rel.get("positive", 0.0) - rel.get("negative", 0.0)) if rel else relationship.score
    await neo4j_writer.write_relationship_edge(
        settings,
        project_id=project_id,
        target_type=target_type,
        target_id=target_id,
        author_id=author_id,
        relationship_score=rel_quality,
    )

    log(logger, "info", "assessed", target_id=target_id, verdict=verdict, auto_actioned=auto_actioned)
    return row


async def process_job(settings: Settings, job: ScoreJob, msg_id: int | None = None) -> None:
    """Consume one pgmq job: fetch the content text by id, then run the cascade core."""
    content = await fetch_content(settings, job.target_type, job.target_id)
    if content is None or not content.text:
        log(logger, "warn", "no content text for job (skipping)", target_id=job.target_id)
        return
    await assess_and_record(
        settings,
        project_id=job.project_id,
        target_type=job.target_type,
        target_id=job.target_id,
        space_id=content.space_id,
        text=content.text,
        author_id=content.author_id,
        source_msg_id=msg_id,
    )
