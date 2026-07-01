"""Shared pytest fixtures + a hermetic env so importing the package never touches a real DB/LLM.

Mirrors the API's test posture: dummy DATABASE_URL/ACCESS_TOKEN_SECRET, empty ANTHROPIC_API_KEY,
so the pure-function suites run with no network or DB.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("ACCESS_TOKEN_SECRET", "test-secret")
# FORCE-default off: telemetry_enabled() treats unset as ON, and setup_telemetry() now binds a real
# :9464 socket for the Prometheus metrics reader — tests that build an app (e.g. test_model_server.py)
# would otherwise open a real port every run. Individual telemetry tests override this via monkeypatch.
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
# FORCE empty (not setdefault): direnv/.env may export a real key into the shell, and a real key
# makes Settings().haiku_enabled() true → the gray-zone cascade fires a *real* Haiku call in tests
# (non-hermetic, flaky). Tests that need Haiku enabled set it per-Settings via dataclasses.replace.
os.environ["ANTHROPIC_API_KEY"] = ""


@pytest.fixture
def secret() -> str:
    return os.environ["ACCESS_TOKEN_SECRET"]
