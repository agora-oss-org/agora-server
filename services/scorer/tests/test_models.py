"""Response-model shapes must match @agora/contract (camelCase aliases)."""

from __future__ import annotations

from scorer.models import Pagination, UserSummary


def test_pagination_matches_contract_meta() -> None:
    p = Pagination(page=1, page_size=20, total_pages=3, total_items=45, has_more=True)
    assert p.model_dump(by_alias=True) == {
        "page": 1, "pageSize": 20, "totalPages": 3, "totalItems": 45, "hasMore": True,
    }


def test_user_summary_reputation_defaults_to_zero() -> None:
    u = UserSummary(id="u1")
    dumped = u.model_dump(by_alias=True)
    assert dumped["reputation"] == 0
    assert dumped["id"] == "u1"
