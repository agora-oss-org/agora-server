"""Write-back to @agora/api — port of ``apps/moderator/src/lib/api-client.ts``.

The API stays the trust boundary: the scorer never mutates entities/comments directly. It
POSTs the decision to ``{API_BASE_URL}/internal/moderation/apply`` gated by the shared
``MODERATION_SERVICE_SECRET`` (header ``x-moderation-secret``), which stamps
``moderationStatus`` + ``moderatedByType="client"``. No-op (returns False) when write-back
isn't configured, so verdicts still persist + queue for humans.

The endpoint URL, header, and body are IDENTICAL to the moderator's (unchanged API contract).

STUB: the httpx POST is sketched; returns False until wired.
"""

from __future__ import annotations

from typing import Literal

from scorer.config import Settings
from scorer.logging import get_logger, log

logger = get_logger("scorer.worker.writeback")


async def apply_moderation(
    settings: Settings,
    *,
    project_id: str,
    target_type: Literal["entity", "comment"],
    target_id: str,
    status: Literal["removed", "approved"],
    reason: str | None = None,
) -> bool:
    if not settings.write_back_enabled():
        return False
    url = f"{settings.api_base_url.rstrip('/')}/internal/moderation/apply"
    _body = {
        "projectId": project_id,
        "targetType": target_type,
        "targetId": target_id,
        "status": status,
        "reason": reason,
    }
    _headers = {"content-type": "application/json", "x-moderation-secret": settings.moderation_service_secret}
    # TODO(scorer): async httpx POST(url, json=_body, headers=_headers, timeout=5) → ok? True : False
    log(logger, "debug", "write-back → API (stub)", url=url, target_type=target_type, target_id=target_id, status=status)
    return False
