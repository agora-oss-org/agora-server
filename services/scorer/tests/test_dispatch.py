"""Job-kind dispatch + the graph-only handlers (reaction / follow).

All Neo4j writers and DB resolvers are monkeypatched, so this exercises the routing + edge-projection
logic with no real infra.
"""

from __future__ import annotations

import pytest

from scorer.config import Settings
from scorer.db import InteractionContext
from worker import neo4j_writer, pipeline


def test_job_kind_defaults_to_content() -> None:
    assert pipeline.job_kind({"targetType": "comment", "targetId": "c1", "projectId": "p1"}) == "content"
    assert pipeline.job_kind({"kind": "reaction", "op": "add"}) == "reaction"
    assert pipeline.job_kind({"kind": "follow", "op": "remove"}) == "follow"
    assert pipeline.job_kind({"kind": "connection", "op": "add"}) == "connection"


def _patch_writers(monkeypatch: pytest.MonkeyPatch) -> dict:
    rec: dict = {}

    async def interaction(settings, **kw):  # noqa: ANN001
        rec["interaction"] = kw

    async def del_interaction(settings, **kw):  # noqa: ANN001
        rec["del_interaction"] = kw

    async def follow(settings, **kw):  # noqa: ANN001
        rec["follow"] = kw

    async def del_follow(settings, **kw):  # noqa: ANN001
        rec["del_follow"] = kw

    async def connection(settings, **kw):  # noqa: ANN001
        rec["connection"] = kw

    async def del_connection(settings, **kw):  # noqa: ANN001
        rec["del_connection"] = kw

    monkeypatch.setattr(neo4j_writer, "write_interaction_edge", interaction)
    monkeypatch.setattr(neo4j_writer, "delete_interaction_edge", del_interaction)
    monkeypatch.setattr(neo4j_writer, "write_follow_edge", follow)
    monkeypatch.setattr(neo4j_writer, "delete_follow_edge", del_follow)
    monkeypatch.setattr(neo4j_writer, "write_connection_edge", connection)
    monkeypatch.setattr(neo4j_writer, "delete_connection_edge", del_connection)
    return rec


async def test_reaction_add_merges_edge_with_type_sentiment(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch_writers(monkeypatch)

    async def fake_resolve(settings, rid):  # noqa: ANN001
        return InteractionContext(actor_id="a1", recipient_id="b1", kind="reaction", reaction_type="upvote")

    monkeypatch.setattr(pipeline, "resolve_reaction_interaction", fake_resolve)
    await pipeline.dispatch_job(
        Settings(), {"kind": "reaction", "op": "add", "reactionId": "r1", "projectId": "p1"}
    )
    assert rec["interaction"]["actor_id"] == "a1"
    assert rec["interaction"]["recipient_id"] == "b1"
    assert rec["interaction"]["kind"] == "reaction"
    assert rec["interaction"]["source_id"] == "r1"
    assert rec["interaction"]["sentiment"] == 1.0  # upvote


async def test_reaction_remove_deletes_edge_by_source_id(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch_writers(monkeypatch)
    # remove must NOT resolve (the row is already gone) — delete by reactionId alone.
    await pipeline.dispatch_job(
        Settings(), {"kind": "reaction", "op": "remove", "reactionId": "r1", "projectId": "p1"}
    )
    assert rec["del_interaction"]["source_id"] == "r1"
    assert "interaction" not in rec


async def test_reaction_on_message_target_writes_no_edge(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch_writers(monkeypatch)

    async def fake_resolve(settings, rid):  # noqa: ANN001
        # chat-message target → recipient unresolved (out of scope)
        return InteractionContext(actor_id="a1", recipient_id=None, kind="reaction", reaction_type="like")

    monkeypatch.setattr(pipeline, "resolve_reaction_interaction", fake_resolve)
    await pipeline.dispatch_job(
        Settings(), {"kind": "reaction", "op": "add", "reactionId": "r1", "projectId": "p1"}
    )
    assert "interaction" not in rec


async def test_follow_add_and_remove_route_to_writers(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch_writers(monkeypatch)
    await pipeline.dispatch_job(
        Settings(), {"kind": "follow", "op": "add", "followerId": "a1", "followedId": "b1", "projectId": "p1"}
    )
    assert rec["follow"] == {"follower_id": "a1", "followed_id": "b1"}
    await pipeline.dispatch_job(
        Settings(), {"kind": "follow", "op": "remove", "followerId": "a1", "followedId": "b1", "projectId": "p1"}
    )
    assert rec["del_follow"] == {"follower_id": "a1", "followed_id": "b1"}


async def test_connection_add_and_remove_route_to_writers(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch_writers(monkeypatch)
    await pipeline.dispatch_job(
        Settings(),
        {"kind": "connection", "op": "add", "requesterId": "a1", "addresseeId": "b1", "projectId": "p1"},
    )
    assert rec["connection"] == {"requester_id": "a1", "addressee_id": "b1"}
    await pipeline.dispatch_job(
        Settings(),
        {"kind": "connection", "op": "remove", "requesterId": "a1", "addresseeId": "b1", "projectId": "p1"},
    )
    assert rec["del_connection"] == {"requester_id": "a1", "addressee_id": "b1"}
