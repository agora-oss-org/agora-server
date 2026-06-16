from __future__ import annotations

from worker.neo4j_writer import canonical_pair


def test_canonical_pair_orders_min_max_regardless_of_direction() -> None:
    assert canonical_pair("aaa", "bbb") == ("aaa", "bbb")
    assert canonical_pair("bbb", "aaa") == ("aaa", "bbb")


def test_canonical_pair_equal_ids() -> None:
    assert canonical_pair("x", "x") == ("x", "x")
