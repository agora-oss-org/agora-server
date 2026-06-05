"""Pydantic models shared across the worker + admin API.

``ModerationAnalysis`` and the pagination envelope are the PRESERVED admin contract — their
field names + casing must match ``@agora/contract``'s ``ModerationAnalysis`` and the API's
``{ data, pagination }`` envelope exactly, or the admin UI breaks. Port of the shapes from
``apps/moderator/src/lib/shape.ts`` + ``packages/contract``.
"""

from __future__ import annotations

from typing import Generic, Literal, Optional, TypeVar

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

ModerationVerdict = Literal["allow", "block", "review"]
ReportTargetType = Literal["entity", "comment", "message"]

T = TypeVar("T")


class CamelModel(BaseModel):
    """Serializes to camelCase (matching the TS contract) while accepting snake_case in code."""

    # protected_namespaces=() because ModerationAnalysis has a legit `model` field (the LLM id).
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, protected_namespaces=())


class ScoreJob(CamelModel):
    """The pgmq job payload enqueued by the Postgres trigger (id-only; worker fetches text)."""

    target_type: ReportTargetType
    target_id: str
    project_id: str
    space_id: Optional[str] = None


class UserSummary(CamelModel):
    id: str
    username: Optional[str] = None
    name: Optional[str] = None
    reputation: Optional[int] = None


class ModerationAnalysis(CamelModel):
    """PRESERVED admin contract — must match @agora/contract ModerationAnalysis."""

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
    human_resolved_at: Optional[str] = None  # ISO datetime; None = unresolved
    created_at: str = ""
    author: Optional[UserSummary] = None


class Pagination(CamelModel):
    page: int
    limit: int
    total: int
    total_pages: int
    has_next_page: bool


class Page(CamelModel, Generic[T]):
    data: list[T]
    pagination: Pagination
