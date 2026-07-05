"""Cascade gate — proves the toxicity gate keys on P(toxic), not the top label's score.

All collaborators (db, model servers, write-back, neo4j) are monkeypatched, so this exercises the
gray-zone decision logic in process_job with no real infra.
"""

from __future__ import annotations

import dataclasses

import pytest

from scorer.config import ResolvedModeratorConfig, Settings
from scorer.db import ContentRow, InteractionContext
from scorer.models import ScoreJob
from worker import analyses, model_clients, neo4j_writer, pipeline, writeback
from worker.model_clients import ModelScore


def _patch(monkeypatch: pytest.MonkeyPatch, *, tox_scores: dict[str, float]) -> dict:
    recorded: dict = {}
    rel_scores = {"negative": 0.2, "neutral": 0.6, "positive": 0.2}

    async def fake_fetch_content(settings, tt, tid):  # noqa: ANN001
        return ContentRow(text="hello world", space_id=None, author_id="author-1")

    async def fake_cfg(settings, pid):  # noqa: ANN001
        return ResolvedModeratorConfig(
            block_auto_action_threshold=0.85, review_auto_action_threshold=0.0, categories=["spam"]
        )

    async def fake_score_both(settings, text, context=None):  # noqa: ANN001
        tox = ModelScore(label=max(tox_scores, key=lambda k: tox_scores[k]), score=max(tox_scores.values()), scores=tox_scores)
        rel = ModelScore(label="neutral", score=0.6, scores=rel_scores)
        return tox, rel

    async def fake_record(settings, data):  # noqa: ANN001
        recorded["data"] = data
        return data  # stands in for the inserted row (what assess_and_record returns)

    async def fake_writeback(settings, **kw):  # noqa: ANN001
        recorded["writeback"] = kw
        return True

    async def fake_neo4j(settings, **kw):  # noqa: ANN001
        recorded["neo4j"] = kw

    async def fake_interaction(settings, **kw):  # noqa: ANN001
        recorded["interaction"] = kw

    async def fake_resolve_comment(settings, cid):  # noqa: ANN001
        return InteractionContext(actor_id="author-1", recipient_id="recipient-1", kind="reply")

    monkeypatch.setattr(pipeline, "fetch_content", fake_fetch_content)
    monkeypatch.setattr(pipeline, "get_moderator_config", fake_cfg)
    monkeypatch.setattr(pipeline, "resolve_comment_interaction", fake_resolve_comment)
    monkeypatch.setattr(model_clients, "score_both", fake_score_both)
    monkeypatch.setattr(analyses, "record_analysis", fake_record)
    monkeypatch.setattr(writeback, "apply_moderation", fake_writeback)
    monkeypatch.setattr(neo4j_writer, "write_relationship_edge", fake_neo4j)
    monkeypatch.setattr(neo4j_writer, "write_interaction_edge", fake_interaction)
    return recorded


def _job() -> ScoreJob:
    return ScoreJob(target_type="entity", target_id="t1", project_id="p1")


async def test_clean_content_with_high_neutral_is_not_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    # The bug guard: top label neutral=0.95 must NOT trip the block gate; P(toxic)=0.05 → allow.
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    await pipeline.process_job(Settings(), _job(), msg_id=1)
    assert rec["data"].verdict == "allow"
    assert "writeback" not in rec  # nothing removed


async def test_high_toxicity_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.1, "toxic": 0.9})
    await pipeline.process_job(Settings(), _job(), msg_id=2)
    assert rec["data"].verdict == "block"
    assert rec["data"].confidence == 0.9
    assert rec["writeback"]["status"] == "removed"  # auto-actioned (0.9 ≥ 0.85)


async def test_grayzone_without_haiku_routes_to_review(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.5, "toxic": 0.5})  # in [0.30, 0.80], Haiku off
    await pipeline.process_job(Settings(), _job(), msg_id=3)
    assert rec["data"].verdict == "review"
    assert rec["data"].source_msg_id == 3


async def test_assess_and_record_returns_the_row(monkeypatch: pytest.MonkeyPatch) -> None:
    # The /analyze path calls the core directly with operator-provided text and returns the recorded row.
    rec = _patch(monkeypatch, tox_scores={"toxic": 0.9, "neutral": 0.1})
    row = await pipeline.assess_and_record(
        Settings(), project_id="p1", target_type="entity", target_id="t1", space_id=None, text="x"
    )
    assert row is rec["data"]
    assert row.source_msg_id is None  # on-demand → no pgmq message
    assert "interaction" not in rec  # write_interaction defaults off (the /analyze path)


async def test_comment_content_job_writes_interaction_edge(monkeypatch: pytest.MonkeyPatch) -> None:
    # A queued comment job projects the user→user INTERACTED edge with the relationship sentiment.
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    job = ScoreJob(target_type="comment", target_id="c1", project_id="p1")
    await pipeline.process_job(Settings(), job, msg_id=7)
    assert rec["interaction"]["recipient_id"] == "recipient-1"
    assert rec["interaction"]["kind"] == "reply"
    assert rec["interaction"]["source_id"] == "c1"
    # rel_quality = P(positive) - P(negative) = 0.2 - 0.2 = 0.0 (from the patched rel_scores)
    assert rec["interaction"]["sentiment"] == pytest.approx(0.0)


async def test_entity_content_job_writes_no_interaction_edge(monkeypatch: pytest.MonkeyPatch) -> None:
    # An entity post has no recipient → only the v1 AUTHORED edge, never an INTERACTED edge.
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    await pipeline.process_job(Settings(), _job(), msg_id=8)
    assert "neo4j" in rec  # v1 AUTHORED edge still written
    assert "interaction" not in rec


def _capture_co_participates(monkeypatch: pytest.MonkeyPatch, rec: dict, participant_ids: list[str]) -> None:
    rec["co_participates"] = []

    async def fake_resolve_co(settings, *, comment_id, actor_id, lookback_days, max_participants):  # noqa: ANN001
        rec["resolve_co_args"] = {"comment_id": comment_id, "actor_id": actor_id}
        return participant_ids

    async def fake_write_co(settings, **kw):  # noqa: ANN001
        rec["co_participates"].append(kw)

    monkeypatch.setattr(pipeline, "resolve_co_participants", fake_resolve_co)
    monkeypatch.setattr(neo4j_writer, "write_co_participates_edge", fake_write_co)


async def test_comment_job_writes_co_participates_when_graph_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    _capture_co_participates(monkeypatch, rec, ["u2", "u3"])
    settings = dataclasses.replace(Settings(), neo4j_uri="bolt://x", neo4j_auth="u/p")
    job = ScoreJob(target_type="comment", target_id="c1", project_id="p1")
    await pipeline.process_job(settings, job, msg_id=11)
    assert rec["resolve_co_args"] == {"comment_id": "c1", "actor_id": "author-1"}
    assert [c["participant_id"] for c in rec["co_participates"]] == ["u2", "u3"]
    assert all(c["actor_id"] == "author-1" and c["project_id"] == "p1" for c in rec["co_participates"])


async def test_entity_job_writes_no_co_participates(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    _capture_co_participates(monkeypatch, rec, ["u2"])
    settings = dataclasses.replace(Settings(), neo4j_uri="bolt://x", neo4j_auth="u/p")
    job = ScoreJob(target_type="entity", target_id="e1", project_id="p1")
    await pipeline.process_job(settings, job, msg_id=12)
    assert rec["co_participates"] == []


async def test_comment_job_skips_co_participates_when_graph_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    _capture_co_participates(monkeypatch, rec, ["u2"])
    job = ScoreJob(target_type="comment", target_id="c1", project_id="p1")
    await pipeline.process_job(Settings(), job, msg_id=13)  # default Settings → neo4j_enabled() is False
    assert rec["co_participates"] == []


async def test_per_project_gray_zone_high_moves_the_block_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    # tox=0.6 is BELOW the default high (0.80) → would escalate/allow. With a per-project high of 0.5,
    # 0.6 ≥ 0.5 → block. Proves the pipeline reads cfg.grayzone_high, not settings.
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.4, "toxic": 0.6})

    async def fake_cfg_low_high(settings, pid):  # noqa: ANN001
        return ResolvedModeratorConfig(
            block_auto_action_threshold=0.85, review_auto_action_threshold=0.0, categories=["spam"],
            grayzone_low=0.30, grayzone_high=0.50,
        )

    monkeypatch.setattr(pipeline, "get_moderator_config", fake_cfg_low_high)
    await pipeline.process_job(Settings(), _job(), msg_id=99)
    assert rec["data"].verdict == "block"
