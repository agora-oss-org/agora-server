"""NEO4J_DATABASE handling: name validation, db-scoped sessions, and startup auto-create.

All infra is faked — no real Neo4j. Mirrors the monkeypatch style in test_pipeline.py.
"""

from __future__ import annotations

import dataclasses

import pytest

from scorer import neo4j
from scorer.config import Settings


# --- valid_db_name (pure branching logic) ---------------------------------------------------------

@pytest.mark.parametrize("name", ["neo4j", "agora", "agora-graph", "a.b.c", "x" * 63])
def test_valid_db_name_accepts_well_formed(name: str) -> None:
    assert neo4j.valid_db_name(name)


@pytest.mark.parametrize(
    "name",
    [
        "",
        "ab",  # too short (<3)
        "x" * 64,  # too long (>63)
        "1graph",  # must start with a letter
        "-graph",  # must start with a letter
        "agora_graph",  # underscores are not allowed by Neo4j
        "Agora",  # uppercase (names are lowercased; reject to be safe)
        "drop database neo4j",  # injection attempt: spaces
        "neo4j; CREATE DATABASE evil",  # injection attempt: semicolon
    ],
)
def test_valid_db_name_rejects_malformed(name: str) -> None:
    assert not neo4j.valid_db_name(name)


# --- db_session binds the configured database -----------------------------------------------------

def test_db_session_passes_configured_database() -> None:
    captured: dict = {}

    class FakeDriver:
        def session(self, **kw):  # noqa: ANN001, ANN201
            captured.update(kw)
            return object()

    settings = dataclasses.replace(Settings(), neo4j_database="agora-graph")
    neo4j.db_session(FakeDriver(), settings)
    assert captured == {"database": "agora-graph"}


# --- ensure_constraints auto-creates a non-default database ---------------------------------------

class _FakeSession:
    def __init__(self, log: list[tuple[str | None, str]], database: str | None) -> None:
        self._log = log
        self._database = database

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *exc) -> bool:  # noqa: ANN002
        return False

    async def run(self, query: str, **_kw) -> None:  # noqa: ANN003
        self._log.append((self._database, query))


class _FakeDriver:
    def __init__(self, log: list[tuple[str | None, str]]) -> None:
        self._log = log

    def session(self, *, database: str | None = None, **_kw):  # noqa: ANN003, ANN201
        return _FakeSession(self._log, database)


async def _run_ensure(monkeypatch: pytest.MonkeyPatch, db: str) -> list[tuple[str | None, str]]:
    log: list[tuple[str | None, str]] = []
    driver = _FakeDriver(log)

    async def fake_get_driver(_settings):  # noqa: ANN001, ANN202
        return driver

    monkeypatch.setattr(neo4j, "get_driver", fake_get_driver)
    settings = dataclasses.replace(Settings(), neo4j_uri="bolt://x", neo4j_auth="u/p", neo4j_database=db)
    await neo4j.ensure_constraints(settings)
    return log


async def test_ensure_constraints_creates_non_default_db(monkeypatch: pytest.MonkeyPatch) -> None:
    log = await _run_ensure(monkeypatch, "agora-graph")
    # CREATE DATABASE runs against the system db, exactly once (backtick-quoted for Cypher parsing).
    creates = [q for d, q in log if d == "system"]
    assert creates == ["CREATE DATABASE `agora-graph` IF NOT EXISTS"]
    # Constraints/indexes run against the target db, never the implicit default.
    target = [q for d, q in log if d == "agora-graph"]
    assert any("constraint scorer_user_id" in q for q in target)
    assert all(d in ("system", "agora-graph") for d, _ in log)


async def test_ensure_constraints_skips_create_for_default_db(monkeypatch: pytest.MonkeyPatch) -> None:
    log = await _run_ensure(monkeypatch, "neo4j")
    assert not any(d == "system" for d, _ in log)  # no CREATE DATABASE for the always-present default
    assert any("constraint scorer_user_id" in q for d, q in log if d == "neo4j")


async def test_ensure_constraints_aborts_on_invalid_db_name(monkeypatch: pytest.MonkeyPatch) -> None:
    log = await _run_ensure(monkeypatch, "evil; DROP DATABASE neo4j")
    assert log == []  # invalid name → no sessions opened, nothing interpolated
