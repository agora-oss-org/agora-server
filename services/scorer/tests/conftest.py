"""Shared pytest fixtures + a hermetic env so importing the package never touches a real DB/LLM.

Mirrors the API's test posture: dummy DATABASE_URL/ACCESS_TOKEN_SECRET, empty ANTHROPIC_API_KEY,
so the pure-function suites run with no network or DB.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("ACCESS_TOKEN_SECRET", "test-secret")
os.environ.setdefault("ANTHROPIC_API_KEY", "")


@pytest.fixture
def secret() -> str:
    return os.environ["ACCESS_TOKEN_SECRET"]
