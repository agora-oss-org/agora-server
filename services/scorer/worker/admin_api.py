"""The operator-gated admin API — port of ``apps/moderator/src/routes/moderation.ts`` (Hono → FastAPI).

PRESERVED CONTRACT: these routes + their response shapes must match what the admin UI
(``apps/admin``) calls, since compose repoints ``MODERATOR_UPSTREAM`` at this worker. The admin
nginx rewrites ``/moderator/* → /v1/*`` and proxies here, so the paths below are the
``/v1/:projectId/moderation/*`` surface verbatim:

    GET  /v1/{projectId}/moderation/config
    GET  /v1/{projectId}/moderation/stats
    GET  /v1/{projectId}/moderation/queue?page=&limit=
    GET  /v1/{projectId}/moderation/analysis?targetType=&targetId=
    POST /v1/{projectId}/moderation/analyze
    POST /v1/{projectId}/moderation/{id}/resolve
    POST /v1/{projectId}/moderation/{id}/remove

All operator-gated via ``scorer/jwt_auth.verify_operator``. Responses use the ``{ data,
pagination }`` envelope + ``ModerationAnalysis`` shape from ``scorer/models``.

STUB: handlers return shape-correct empty/placeholder payloads so the admin contract holds and
the UI doesn't error; real reads/writes land with ``scorer/db.py`` in the impl pass.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from scorer.config import get_settings
from scorer.jwt_auth import AuthContext, AuthError, verify_operator
from scorer.models import ModerationAnalysis, Page, Pagination

router = APIRouter(prefix="/v1/{project_id}/moderation")


def require_operator(authorization: str | None = Header(default=None)) -> AuthContext:
    try:
        return verify_operator(authorization, get_settings().access_token_secret)
    except AuthError as exc:
        raise HTTPException(status_code=401, detail={"error": str(exc), "code": "auth/forbidden"}) from exc


@router.get("/config")
def get_config(project_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, object]:
    s = get_settings()
    # Redacted running config (never leak secrets) — booleans for key presence.
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
def get_stats(project_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, int]:
    # TODO(scorer): aggregate from moderation_analyses.
    return {"total": 0, "blocks": 0, "reviews": 0, "allows": 0, "autoBlocks": 0,
            "promptTokens": 0, "completionTokens": 0, "totalTokens": 0}


@router.get("/queue", response_model=Page[ModerationAnalysis])
def get_queue(
    project_id: str,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    _auth: AuthContext = Depends(require_operator),
) -> Page[ModerationAnalysis]:
    # TODO(scorer): unresolved (block/review, human_resolved_at is null) with author summaries.
    return Page(data=[], pagination=Pagination(page=page, limit=limit, total=0, total_pages=0, has_next_page=False))


@router.get("/analysis")
def get_analysis(
    project_id: str,
    target_type: str = Query(..., alias="targetType"),
    target_id: str = Query(..., alias="targetId"),
    _auth: AuthContext = Depends(require_operator),
) -> ModerationAnalysis | None:
    # TODO(scorer): latest analysis for one target. None until wired.
    return None


@router.post("/analyze")
def post_analyze(project_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, object]:
    # TODO(scorer): on-demand (re)assessment via the cascade.
    raise HTTPException(status_code=501, detail={"error": "not implemented (foundation)", "code": "scorer/stub"})


@router.post("/{analysis_id}/resolve")
def post_resolve(project_id: str, analysis_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, bool]:
    # TODO(scorer): set human_resolved_at = now() (dismiss flag, leave content).
    raise HTTPException(status_code=501, detail={"error": "not implemented (foundation)", "code": "scorer/stub"})


@router.post("/{analysis_id}/remove")
def post_remove(project_id: str, analysis_id: str, _auth: AuthContext = Depends(require_operator)) -> dict[str, bool]:
    # TODO(scorer): confirm flag + write-back removal through the API.
    raise HTTPException(status_code=501, detail={"error": "not implemented (foundation)", "code": "scorer/stub"})
