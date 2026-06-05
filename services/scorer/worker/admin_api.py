"""The operator-gated admin API — port of ``apps/moderator/src/routes/moderation.ts`` (Hono → FastAPI).

PRESERVED CONTRACT: these routes + their response shapes must match what the admin UI (``apps/admin``)
calls, since compose repoints ``MODERATOR_UPSTREAM`` at this worker. The admin nginx rewrites
``/moderator/* → /v1/*`` and proxies here, so the paths below are the ``/v1/:projectId/moderation/*``
surface verbatim:

    GET  /v1/{projectId}/moderation/config
    GET  /v1/{projectId}/moderation/stats
    GET  /v1/{projectId}/moderation/queue?page=&limit=
    GET  /v1/{projectId}/moderation/analysis?targetType=&targetId=
    POST /v1/{projectId}/moderation/analyze            ← on-demand re-assess (wired in a later step)
    POST /v1/{projectId}/moderation/{id}/resolve       ← dismiss a flag
    POST /v1/{projectId}/moderation/{id}/remove        ← confirm + write-back removal (needs step 4)

All operator-gated via ``scorer/jwt_auth.verify_operator``; responses use the ``{ data, pagination }``
envelope + ``ModerationAnalysis`` shape from ``scorer/models``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from scorer import db
from scorer.config import get_settings
from scorer.jwt_auth import AuthContext, AuthError, verify_operator
from scorer.models import ModerationAnalysis, Page, Pagination

from . import analyses

router = APIRouter(prefix="/v1/{project_id}/moderation")


def require_operator(authorization: str | None = Header(default=None)) -> AuthContext:
    try:
        return verify_operator(authorization, get_settings().access_token_secret)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail={"error": str(exc), "code": "auth/forbidden"}) from exc


@router.get("/config")
def get_config(project_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, object]:
    s = get_settings()
    # Redacted running config (never leak secrets) — booleans for capability presence.
    return {
        "blockAutoActionThreshold": s.block_auto_action_threshold,
        "reviewAutoActionThreshold": s.review_auto_action_threshold,
        "grayzoneLow": s.grayzone_low,
        "grayzoneHigh": s.grayzone_high,
        "haikuModel": s.haiku_model,
        "haikuEnabled": s.haiku_enabled(),
        "writeBackEnabled": s.write_back_enabled(),
        "neo4jEnabled": s.neo4j_enabled(),
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
    rows, total = await db.fetch_queue(get_settings(), project_id, page, limit)
    total_pages = (total + limit - 1) // limit
    return Page(
        data=[analyses.shape_analysis(r) for r in rows],
        pagination=Pagination(
            page=page, limit=limit, total=total, total_pages=total_pages, has_next_page=page < total_pages
        ),
    )


@router.get("/analysis")
async def get_analysis(
    project_id: str,
    target_type: str = Query(..., alias="targetType"),
    target_id: str = Query(..., alias="targetId"),
    _auth: AuthContext = Depends(require_operator),
) -> ModerationAnalysis | None:
    row = await db.fetch_latest_analysis(get_settings(), project_id, target_type, target_id)
    return analyses.shape_analysis(row) if row is not None else None


@router.post("/analyze")
def post_analyze(project_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, object]:
    # On-demand (re)assessment runs the cascade; wired once the model clients + Haiku are live.
    raise HTTPException(status_code=501, detail={"error": "not implemented yet", "code": "scorer/todo"})


@router.post("/{analysis_id}/resolve")
async def post_resolve(
    project_id: str, analysis_id: str, _auth: AuthContext = Depends(require_operator)
) -> dict[str, bool]:
    ok = await db.resolve_analysis(get_settings(), project_id, analysis_id)
    if not ok:
        raise HTTPException(status_code=404, detail={"error": "analysis not found", "code": "scorer/not-found"})
    return {"ok": True}


@router.post("/{analysis_id}/remove")
def post_remove(project_id: str, analysis_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, bool]:
    # Confirm flag + write-back removal — needs the API write-back (step 4).
    raise HTTPException(status_code=501, detail={"error": "not implemented yet", "code": "scorer/todo"})
