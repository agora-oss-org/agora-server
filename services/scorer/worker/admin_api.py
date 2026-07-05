"""The operator-gated admin API — port of ``apps/moderator/src/routes/moderation.ts`` (Hono → FastAPI).

PRESERVED CONTRACT: the routes + response shapes must match the admin client
(`apps/admin/src/lib/moderation-ai.ts`), since compose repoints `MODERATOR_UPSTREAM` at this worker.
The admin nginx rewrites `/moderator/* → /v1/*`, so the paths below are the
`/v1/:projectId/moderation/*` surface verbatim. All operator-gated via `scorer/jwt_auth.verify_operator`.
"""

from __future__ import annotations

import os
import socket
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from scorer import db
from scorer.config import get_settings
from scorer.jwt_auth import AuthContext, AuthError, verify_operator
from scorer.models import CamelModel, ModerationAnalysis, Page, Pagination, ReportTargetType
from scorer.reason import moderation_reason_text

from . import analyses, writeback
from .pipeline import assess_and_record

router = APIRouter(prefix="/v1/{project_id}/moderation")

_STARTED_AT = time.time()


def require_operator(authorization: str | None = Header(default=None)) -> AuthContext:
    try:
        return verify_operator(authorization, get_settings().access_token_secret)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail={"error": str(exc), "code": "auth/forbidden"}) from exc


class AnalyzeBody(CamelModel):
    target_type: ReportTargetType
    target_id: str
    space_id: Optional[str] = None
    text: str
    context: Optional[str] = None


class RemoveBody(BaseModel):
    reason: Optional[str] = None


def _page(rows_with_authors: list[ModerationAnalysis], total: int, page: int, limit: int) -> Page[ModerationAnalysis]:
    total_pages = max(1, (total + limit - 1) // limit)
    return Page(
        data=rows_with_authors,
        pagination=Pagination(
            page=page, page_size=limit, total_pages=total_pages, total_items=total, has_more=page < total_pages
        ),
    )


@router.get("/config")
def get_config(project_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, object]:
    s = get_settings()
    db_info: Optional[dict[str, object]] = None
    if s.database_url:
        try:
            u = urlparse(s.database_url)
            db_info = {"host": u.hostname, "database": (u.path or "/").lstrip("/") or None}
        except ValueError:
            db_info = None
    return {
        "service": "agora-scorer-worker",
        "node": socket.gethostname(),
        "pid": os.getpid(),
        "uptimeSeconds": int(time.time() - _STARTED_AT),
        "startedAt": datetime.fromtimestamp(_STARTED_AT, tz=timezone.utc).isoformat(),
        "config": {
            "port": s.admin_port,
            "corsOrigin": "*",
            "database": db_info,
            "accessTokenSecretSet": bool(s.access_token_secret),
            "writeBack": {
                "apiBaseUrl": s.api_base_url,
                "serviceSecretSet": bool(s.moderation_service_secret),
                "enabled": s.write_back_enabled(),
            },
            "defaults": {
                "blockAutoActionThreshold": s.block_auto_action_threshold,
                "reviewAutoActionThreshold": s.review_auto_action_threshold,
                "grayzoneLow": s.grayzone_low,
                "grayzoneHigh": s.grayzone_high,
                "coParticipates": {
                    "lookbackDays": s.co_participates_lookback_days,
                    "maxParticipants": s.co_participates_max_participants,
                    "maxWeight": s.co_participates_max_weight,
                },
                # The scorer adjudicates the gray zone with Claude Haiku; report it in the llm slot.
                "llm": {
                    "provider": "anthropic",
                    "baseUrl": None,
                    "model": s.haiku_model,
                    "maxTokens": s.haiku_max_tokens,
                    "apiKeySet": s.haiku_enabled(),
                    "enabled": s.haiku_enabled(),
                },
            },
            # Read-only deployment wiring (env-owned; restart to change). Secrets as booleans only.
            "deployment": {
                "listenDatabaseUrlSet": bool(s.listen_database_url),
                "anthropicApiKeySet": s.haiku_enabled(),
                "toxicityUrl": s.toxicity_url,
                "relationshipUrl": s.relationship_url,
                "queue": s.queue,
                "pollIntervalMs": s.poll_interval_ms,
                "visibilityTimeoutS": s.visibility_timeout_s,
                "neo4j": {
                    "uriSet": bool(s.neo4j_uri),
                    "authSet": bool(s.neo4j_auth),
                    "database": s.neo4j_database,
                    "enabled": s.neo4j_enabled(),
                },
            },
        },
    }


@router.get("/stats")
async def get_stats(project_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, int]:
    return await db.fetch_stats(get_settings(), project_id)


@router.get("/queue", response_model=Page[ModerationAnalysis])
async def get_queue(
    project_id: str,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    _auth: AuthContext = Depends(require_operator),
) -> Page[ModerationAnalysis]:
    settings = get_settings()
    rows, total = await db.fetch_queue(settings, project_id, page, limit)
    authors = await db.fetch_authors(settings, [(r["target_type"], str(r["target_id"])) for r in rows])
    shaped = [analyses.shape_analysis(r, authors.get(str(r["target_id"]))) for r in rows]
    return _page(shaped, total, page, limit)


@router.get("/analysis")
async def get_analysis(
    project_id: str,
    target_type: str = Query(..., alias="targetType"),
    target_id: str = Query(..., alias="targetId"),
    _auth: AuthContext = Depends(require_operator),
) -> dict[str, Optional[ModerationAnalysis]]:
    row = await db.fetch_latest_analysis(get_settings(), project_id, target_type, target_id)
    return {"analysis": analyses.shape_analysis(row) if row is not None else None}


@router.post("/analyze", response_model=ModerationAnalysis)
async def post_analyze(
    project_id: str, body: AnalyzeBody, _auth: AuthContext = Depends(require_operator)
) -> ModerationAnalysis:
    row = await assess_and_record(
        get_settings(),
        project_id=project_id,
        target_type=body.target_type,
        target_id=body.target_id,
        space_id=body.space_id,
        text=body.text,
        context=body.context,
    )
    if row is None:
        raise HTTPException(status_code=500, detail={"error": "analysis not recorded", "code": "scorer/insert-failed"})
    return analyses.shape_analysis(row)


@router.post("/{analysis_id}/resolve", response_model=ModerationAnalysis)
async def post_resolve(
    project_id: str, analysis_id: str, _auth: AuthContext = Depends(require_operator)
) -> ModerationAnalysis:
    row = await db.resolve_analysis(get_settings(), project_id, analysis_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "analysis not found", "code": "scorer/not-found"})
    return analyses.shape_analysis(row)


@router.post("/{analysis_id}/remove", response_model=ModerationAnalysis)
async def post_remove(
    project_id: str,
    analysis_id: str,
    body: Optional[RemoveBody] = None,
    _auth: AuthContext = Depends(require_operator),
) -> ModerationAnalysis:
    settings = get_settings()
    row = await db.fetch_analysis_by_id(settings, project_id, analysis_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "analysis not found", "code": "scorer/not-found"})
    target_type = row["target_type"]
    if target_type not in ("entity", "comment"):
        raise HTTPException(status_code=400, detail={"error": "target not removable", "code": "scorer/not-removable"})
    if not settings.write_back_enabled():
        raise HTTPException(status_code=503, detail={"error": "write-back not configured", "code": "scorer/no-writeback"})
    reason = (body.reason if body else None) or moderation_reason_text(
        row["verdict"], float(row["confidence"]), row["reason"]
    )
    ok = await writeback.apply_moderation(
        settings, project_id=project_id, target_type=target_type, target_id=str(row["target_id"]),
        status="removed", reason=reason,
    )
    if not ok:
        raise HTTPException(status_code=502, detail={"error": "write-back failed", "code": "scorer/writeback-failed"})
    updated = await db.mark_removed(settings, project_id, analysis_id)
    return analyses.shape_analysis(updated if updated is not None else row)
