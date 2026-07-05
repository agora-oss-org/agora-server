"""Pydantic models shared across the worker + admin API.

``ModerationAnalysis`` and the pagination envelope are the PRESERVED admin contract — their
field names + casing must match ``@agora-server/contract``'s ``ModerationAnalysis`` and the API's
``{ data, pagination }`` envelope exactly, or the admin UI breaks. Port of the shapes from
``apps/moderator/src/lib/shape.ts`` + ``packages/contract``.
"""

from __future__ import annotations

from typing import Generic, Literal, Optional, TypeVar

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

ModerationVerdict = Literal["allow", "block", "review"]
# Scored target types. (No "message": chat is end-to-end-encrypted secure chat — never scored. The
# reaction_target DB enum still carries `message` for chat-message *reports*, a separate feature.)
ReportTargetType = Literal["entity", "comment"]

T = TypeVar("T")


class CamelModel(BaseModel):
    """Serializes to camelCase (matching the TS contract) while accepting snake_case in code."""

    # protected_namespaces=() because ModerationAnalysis has a legit `model` field (the LLM id).
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, protected_namespaces=())


class ScoreJob(CamelModel):
    """The pgmq content-scoring job (id-only; worker fetches text). ``kind`` defaults to ``"content"``
    so a pre-v2 payload (no discriminator) still parses."""

    kind: Literal["content"] = "content"
    target_type: ReportTargetType
    target_id: str
    project_id: str
    space_id: Optional[str] = None


class ReactionJob(CamelModel):
    """Graph job for a reaction add/remove/retype (migration 0036). No scoring — the INTERACTED edge's
    sentiment is derived from the reaction type. ``remove`` deletes the edge by ``reactionId``."""

    kind: Literal["reaction"]
    op: Literal["add", "remove"]
    reaction_id: str
    project_id: str


class FollowJob(CamelModel):
    """Graph job for a follow/unfollow (migration 0036). Structural FOLLOWS edge — no scoring."""

    kind: Literal["follow"]
    op: Literal["add", "remove"]
    follower_id: str
    followed_id: str
    project_id: str


class ConnectionJob(CamelModel):
    """Graph job for a mutual connection becoming/leaving `connected` (migration 0037). Structural
    CONNECTED edge — no scoring. ``add`` on accept/direct-connect, ``remove`` on disconnect/decline."""

    kind: Literal["connection"]
    op: Literal["add", "remove"]
    requester_id: str
    addressee_id: str
    project_id: str


class FrictionJob(CamelModel):
    """Graph job for a user report → directed FRICTION edge (migration 0039). No scoring — a report
    carries no text; its friction weight is a constant. Append + decay only: ``op`` is always ``"add"``
    (kept for symmetry with the other graph jobs), there is no ``remove`` — a FRICTION edge decays at the
    friction half-life and a later report resolution is a no-op in the graph."""

    kind: Literal["friction"]
    op: Literal["add"]
    report_id: str
    project_id: str


class UserSummary(CamelModel):
    id: str
    username: Optional[str] = None
    name: Optional[str] = None
    reputation: int = 0


class ModerationAnalysis(CamelModel):
    """PRESERVED admin contract — must match @agora-server/contract ModerationAnalysis."""

    id: str
    project_id: str
    target_type: ReportTargetType
    target_id: str
    space_id: Optional[str] = None
    verdict: ModerationVerdict
    categories: list[str] = []
    confidence: float = 0.0
    reason: str = ""
    model: str = ""
    auto_actioned: bool = False
    # Raw classifier signals (None on rows recorded before they existed). Audit context, not a gate.
    toxicity_score: Optional[float] = None
    relationship_score: Optional[float] = None
    human_resolved_at: Optional[str] = None  # ISO datetime; None = unresolved
    created_at: str = ""
    author: Optional[UserSummary] = None


class Pagination(CamelModel):
    # Matches @agora-server/contract PaginationMeta: { page, pageSize, totalPages, totalItems, hasMore }.
    page: int
    page_size: int
    total_pages: int
    total_items: int
    has_more: bool


class Page(CamelModel, Generic[T]):
    data: list[T]
    pagination: Pagination
