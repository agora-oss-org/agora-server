"""The cascade — the heart of the worker. Shape-port of ``apps/moderator/src/lib/assess-and-record.ts``.

Per job (after the worker fetches the content text by id):

  1. score_both()         → toxicity + relationship RoBERTa scores, in parallel
  2. gray-zone gate       → if toxicity in [grayzone_low, grayzone_high], escalate to Claude Haiku
                            (salvaged policy prompt + verdict schema). Below low → allow; above
                            high → block (high-confidence); Haiku may override within the band.
  3. decide_auto_action() → salvaged pure fn over the verdict + per-project thresholds
  4. apply_moderation()   → write-back through the API (entity/comment only; messages queue)
  5. upsert_analysis()    → idempotent moderation_analyses row (the admin queue source)
  6. write_relationship_edge() → idempotent Neo4j MERGE (graph schema out of scope)

STUB: the control flow is laid out with real calls into the (stubbed) collaborators so the
shape is exercisable; the scoring→verdict mapping details are finalized in the impl pass.
"""

from __future__ import annotations

from scorer.auto_action import AutoActionThresholds, decide_auto_action
from scorer.config import Settings
from scorer.db import fetch_content, get_moderator_config
from scorer.haiku import assess as haiku_assess
from scorer.logging import get_logger, log
from scorer.models import ScoreJob
from scorer.reason import moderation_reason_text

from . import analyses, model_clients, neo4j_writer, writeback

logger = get_logger("scorer.worker.pipeline")


async def process_job(settings: Settings, job: ScoreJob, msg_id: int | None = None) -> None:
    """Run one job through the full cascade. Idempotent end-to-end (pgmq is at-least-once):
    the analysis insert dedups on ``msg_id``, and the write-back + Neo4j MERGE are idempotent."""
    content = await fetch_content(settings, job.target_type, job.target_id)
    if content is None or not content.text:
        log(logger, "warn", "no content text for job (skipping)", target_id=job.target_id)
        return
    text = content.text

    toxicity, relationship = await model_clients.score_both(settings, text)
    cfg = await get_moderator_config(settings, job.project_id)

    # ── gray-zone cascade ──────────────────────────────────────────────────────
    tox = toxicity.score
    verdict, categories, confidence, reason, model = "allow", [], tox, "", "roberta:toxicity"
    prompt_tokens = completion_tokens = 0
    if tox >= settings.grayzone_high:
        verdict, confidence, reason = "block", tox, "High toxicity score"
    elif tox >= settings.grayzone_low:
        # Borderline → ask Haiku for a nuanced verdict (None when disabled or errored → human review).
        result = await haiku_assess(settings, text, cfg.categories) if settings.haiku_enabled() else None
        if result is not None:
            verdict, categories, confidence, reason = result.verdict, result.categories, result.confidence, result.reason
            model = result.model
            prompt_tokens, completion_tokens = result.prompt_tokens, result.completion_tokens
        else:
            verdict, confidence, reason = "review", tox, "Borderline toxicity; queued for human review"

    # ── decide + apply auto-action (entity/comment only) ───────────────────────
    trigger = decide_auto_action(
        verdict, confidence, job.target_type,
        AutoActionThresholds(cfg.block_auto_action_threshold, cfg.review_auto_action_threshold),
    )
    auto_actioned = False
    if trigger is not None and job.target_type in ("entity", "comment"):
        auto_actioned = await writeback.apply_moderation(
            settings,
            project_id=job.project_id,
            target_type=job.target_type,  # type: ignore[arg-type]
            target_id=job.target_id,
            status="removed",
            reason=moderation_reason_text(verdict, confidence, reason),
        )

    # ── record the audit row (admin queue source), deduped on the pgmq msg_id ───
    await analyses.record_analysis(
        settings,
        analyses.AnalysisInput(
            project_id=job.project_id,
            target_type=job.target_type,
            target_id=job.target_id,
            space_id=content.space_id,
            verdict=verdict,
            categories=categories,
            confidence=confidence,
            reason=reason,
            model=model,
            auto_actioned=auto_actioned,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            source_msg_id=msg_id,
        ),
    )

    # ── relationship edge → Neo4j (graph schema out of scope) ──────────────────
    rel_score = relationship.score
    await neo4j_writer.write_relationship_edge(
        settings,
        project_id=job.project_id,
        target_type=job.target_type,
        target_id=job.target_id,
        author_id=content.author_id,
        relationship_score=rel_score,
    )

    log(logger, "info", "job processed", target_id=job.target_id, verdict=verdict, auto_actioned=auto_actioned)
