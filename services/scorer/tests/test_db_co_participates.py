from __future__ import annotations

import pytest

import scorer.db as db_module
from scorer.config import Settings


async def test_resolve_co_participants_stringifies_and_passes_through(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    class FakePool:
        async def fetch(self, sql, *args):  # noqa: ANN001
            captured["sql"] = sql
            captured["args"] = args
            return [{"user_id": "u1"}, {"user_id": "u2"}]

    async def fake_get_pool(settings):  # noqa: ANN001
        return FakePool()

    monkeypatch.setattr(db_module, "get_pool", fake_get_pool)
    out = await db_module.resolve_co_participants(Settings(), comment_id="c1", actor_id="a1")
    assert out == ["u1", "u2"]
    # comment id, actor id, lookback days, cap — in that positional order.
    assert captured["args"] == ("c1", "a1", 7, 50)
    assert "make_interval(days => $3)" in captured["sql"]
