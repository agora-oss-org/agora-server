"""The cascade — the heart of the worker. Shape-port of ``apps/moderator/src/lib/assess-and-record.ts``.

``assess_and_record`` is the reusable core (given the text): score both models in parallel → gray-zone
gate on **P(toxic)** → escalate borderline to Claude Haiku → decide auto-action → write-back removal
(entity/comment only) → record the (deduped) ``moderation_analyses`` row → MERGE the Neo4j relationship
edge → return the inserted row. ``process_job`` fetches the content text by id then calls the core (with
the pgmq ``msg_id`` for dedup); the admin ``/analyze`` endpoint calls the core with operator-provided text
(no pgmq message → ``source_msg_id=None``).
"""

from __future__ import annotations

from typing import Any, Optional, cast

import asyncpg

from scorer.auto_action import AutoActionThresholds, ModerationVerdict, ReportTargetType, decide_auto_action
from scorer.config import Settings
from scorer.db import (
    fetch_content,
    get_moderator_config,
    resolve_comment_interaction,
    resolve_reaction_interaction,
)
from scorer.haiku import assess as haiku_assess
from scorer.logging import get_logger, log
from scorer.models import ConnectionJob, FollowJob, ReactionJob, ScoreJob
from scorer.reason import moderation_reason_text
from scorer.reaction_sentiment import reaction_sentiment

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
    write_interaction: bool = False,
) -> Optional[asyncpg.Record]:
    """Run the full cascade over ``text`` and record one analysis. Returns the inserted row (None on a
    dedup conflict). Idempotent: the insert dedups on ``source_msg_id``; write-back + MERGE are idempotent.

    ``write_interaction`` (queue content path only) also projects the user→user INTERACTED edge for a
    comment/reply — off for the on-demand ``/analyze`` path, whose operator-provided text may not match
    the stored row."""
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

    # ── relationship edges → Neo4j ─────────────────────────────────────────────
    # Signed quality in [-1, 1] (P(positive) - P(negative)); fall back to top score for non-sentiment models.
    rel = relationship.scores
    rel_quality = (rel.get("positive", 0.0) - rel.get("negative", 0.0)) if rel else relationship.score
    # v1: author → content (every scored item).
    await neo4j_writer.write_relationship_edge(
        settings,
        project_id=project_id,
        target_type=target_type,
        target_id=target_id,
        author_id=author_id,
        relationship_score=rel_quality,
    )
    # v2: actor → recipient INTERACTED edge — comments/replies only (an entity post has no recipient).
    if write_interaction and target_type == "comment":
        ctx = await resolve_comment_interaction(settings, target_id)
        if ctx is not None:
            await neo4j_writer.write_interaction_edge(
                settings,
                project_id=project_id,
                actor_id=ctx.actor_id,
                recipient_id=ctx.recipient_id,
                kind=ctx.kind,
                source_id=target_id,
                sentiment=rel_quality,
            )

    log(logger, "info", "assessed", target_id=target_id, verdict=verdict, auto_actioned=auto_actioned)
    return row


async def process_job(settings: Settings, job: ScoreJob, msg_id: int | None = None) -> None:
    """Consume one pgmq content job: fetch the content text by id, then run the cascade core."""
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
        write_interaction=True,
    )


async def process_reaction_job(settings: Settings, job: ReactionJob) -> None:
    """Project a reaction add/remove/retype onto the user→user INTERACTED graph (no scoring — sentiment
    is derived from the reaction type). ``remove`` deletes the edge by reaction id; ``add`` resolves the
    recipient and MERGEs the edge."""
    if job.op == "remove":
        await neo4j_writer.delete_interaction_edge(settings, source_id=job.reaction_id)
        return
    ctx = await resolve_reaction_interaction(settings, job.reaction_id)
    if ctx is None:
        log(logger, "warn", "reaction gone/unresolvable (skipping)", reaction_id=job.reaction_id)
        return
    if ctx.recipient_id is None:
        # chat-message reaction (out of scope) or the target's author is gone — no edge.
        log(logger, "debug", "reaction has no graph recipient (skipping)", reaction_id=job.reaction_id)
        return
    await neo4j_writer.write_interaction_edge(
        settings,
        project_id=job.project_id,
        actor_id=ctx.actor_id,
        recipient_id=ctx.recipient_id,
        kind="reaction",
        source_id=job.reaction_id,
        sentiment=reaction_sentiment(ctx.reaction_type or ""),
    )


async def process_follow_job(settings: Settings, job: FollowJob) -> None:
    """Project a follow/unfollow onto the structural FOLLOWS graph."""
    if job.op == "remove":
        await neo4j_writer.delete_follow_edge(
            settings, follower_id=job.follower_id, followed_id=job.followed_id
        )
    else:
        await neo4j_writer.write_follow_edge(
            settings, follower_id=job.follower_id, followed_id=job.followed_id
        )


async def process_connection_job(settings: Settings, job: ConnectionJob) -> None:
    """Project a connection becoming/leaving `connected` onto the structural CONNECTED graph."""
    if job.op == "remove":
        await neo4j_writer.delete_connection_edge(
            settings, requester_id=job.requester_id, addressee_id=job.addressee_id
        )
    else:
        await neo4j_writer.write_connection_edge(
            settings, requester_id=job.requester_id, addressee_id=job.addressee_id
        )


def job_kind(message: dict[str, Any]) -> str:
    """The job-kind discriminator; a pre-v2 payload without it is a ``content`` job."""
    return str(message.get("kind", "content"))


async def dispatch_job(settings: Settings, message: dict[str, Any], msg_id: int | None = None) -> None:
    """Route one pgmq message to its handler by ``kind`` (content scoring vs. graph-only projection)."""
    kind = job_kind(message)
    if kind == "reaction":
        await process_reaction_job(settings, ReactionJob(**message))
    elif kind == "follow":
        await process_follow_job(settings, FollowJob(**message))
    elif kind == "connection":
        await process_connection_job(settings, ConnectionJob(**message))
    else:
        await process_job(settings, ScoreJob(**message), msg_id=msg_id)
