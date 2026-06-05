"""Write-back to the API: success (with the right header/body), disabled, and rejected."""

from __future__ import annotations

import dataclasses
import json

import httpx
import respx

from scorer.config import Settings
from worker import writeback


def _settings(**over: object) -> Settings:
    return dataclasses.replace(Settings(), **over)


@respx.mock
async def test_apply_moderation_success_sends_secret_and_body() -> None:
    s = _settings(api_base_url="http://agora:4000", moderation_service_secret="sek")
    route = respx.post("http://agora:4000/internal/moderation/apply").mock(
        return_value=httpx.Response(200, json={"success": True})
    )
    ok = await writeback.apply_moderation(
        s, project_id="p", target_type="entity", target_id="t", status="removed", reason="AI block"
    )
    assert ok is True
    req = route.calls.last.request
    assert req.headers["x-moderation-secret"] == "sek"
    body = json.loads(req.content)
    assert body["targetType"] == "entity"
    assert body["status"] == "removed"
    assert body["projectId"] == "p"


async def test_apply_moderation_disabled_returns_false() -> None:
    s = _settings(api_base_url=None, moderation_service_secret=None)
    ok = await writeback.apply_moderation(s, project_id="p", target_type="entity", target_id="t", status="removed")
    assert ok is False


@respx.mock
async def test_apply_moderation_rejected_returns_false() -> None:
    s = _settings(api_base_url="http://agora:4000", moderation_service_secret="sek")
    respx.post("http://agora:4000/internal/moderation/apply").mock(return_value=httpx.Response(404, json={}))
    ok = await writeback.apply_moderation(s, project_id="p", target_type="comment", target_id="t", status="removed")
    assert ok is False
