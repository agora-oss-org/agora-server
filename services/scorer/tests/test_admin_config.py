"""GET /config exposes the new gray-zone/co-participates defaults + a read-only deployment block.
Called directly (the Depends(require_operator) only binds under FastAPI routing; the param is unused)."""

from __future__ import annotations

from typing import Any, cast

from worker.admin_api import get_config


def test_config_reports_gray_zone_and_deployment() -> None:
    # get_config returns dict[str, object]; cast so the nested reads below aren't "object not indexable".
    out = cast(dict[str, Any], get_config("p1", None))  # type: ignore[arg-type]
    defaults = out["config"]["defaults"]
    assert "grayzoneLow" in defaults and "grayzoneHigh" in defaults
    assert defaults["coParticipates"]["maxParticipants"] == 50
    deploy = out["config"]["deployment"]
    assert "toxicityUrl" in deploy and "relationshipUrl" in deploy
    assert deploy["queue"] == "scorer_jobs"
    assert set(deploy["neo4j"]) == {"uriSet", "authSet", "database", "enabled"}
    # secrets are booleans, never values
    assert isinstance(deploy["anthropicApiKeySet"], bool)
