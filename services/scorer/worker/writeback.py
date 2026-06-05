"""Write-back to @agora/api — port of ``apps/moderator/src/lib/api-client.ts``.

The API stays the trust boundary: the scorer never mutates entities/comments directly. It POSTs the
decision to ``{API_BASE_URL}/internal/moderation/apply`` gated by the shared
``MODERATION_SERVICE_SECRET`` (header ``x-moderation-secret``), which stamps ``moderationStatus`` +
``moderatedByType="client"``. No-op (returns False) when write-back isn't configured, so verdicts still
persist + queue for humans. The endpoint URL, header, and body are IDENTICAL to the moderator's.
"""

from __future__ import annotations

from typing import Literal, Optional

import httpx

from scorer.config import Settings
from scorer.logging import get_logger, log

logger = get_logger("scorer.worker.writeback")

_TIMEOUT_S = 5.0


async def apply_moderation(
    settings: Settings,
    *,
    project_id: str,
    target_type: Literal["entity", "comment"],
    target_id: str,
    status: Literal["removed", "approved"],
    reason: Optional[str] = None,
) -> bool:
    if not settings.write_back_enabled():
        return False
    url = f"{settings.api_base_url.rstrip('/')}/internal/moderation/apply"  # type: ignore[union-attr]
    body = {
        "projectId": project_id,
        "targetType": target_type,
        "targetId": target_id,
        "status": status,
        "reason": reason,
    }
    headers = {"content-type": "application/json", "x-moderation-secret": settings.moderation_service_secret or ""}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            res = await client.post(url, json=body, headers=headers)
        if res.status_code >= 400:
            log(logger, "error", "write-back rejected", status=res.status_code, target_id=target_id)
            return False
        log(logger, "info", "write-back applied", target_type=target_type, target_id=target_id, status=status)
        return True
    except httpx.HTTPError as exc:
        log(logger, "error", "write-back failed", err=str(exc), target_id=target_id)
        return False
