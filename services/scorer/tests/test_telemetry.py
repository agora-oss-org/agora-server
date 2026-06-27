"""Telemetry config gating + log trace-context injection (scorer/telemetry.py + scorer/logging.py)."""

from __future__ import annotations

import logging

import pytest

from scorer.logging import _JsonFormatter
from scorer.telemetry import setup_telemetry, telemetry_enabled


def _record(msg: str = "hi") -> logging.LogRecord:
    return logging.LogRecord("scorer.test", logging.INFO, __file__, 1, msg, None, None)


def test_telemetry_enabled_respects_disabled_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    for off in ("true", "TRUE", "1", "yes"):
        monkeypatch.setenv("OTEL_SDK_DISABLED", off)
        assert telemetry_enabled() is False
    monkeypatch.setenv("OTEL_SDK_DISABLED", "false")
    assert telemetry_enabled() is True
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    assert telemetry_enabled() is True  # unset → on (compose sets it true to stay dark by default)


def test_setup_telemetry_is_noop_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    assert setup_telemetry(None, service_name="agora-scorer-test") is False


def test_log_has_no_trace_id_without_active_span() -> None:
    # No span in context (or OTel absent) → no trace fields, logging works unchanged.
    out = _JsonFormatter().format(_record())
    assert '"trace_id"' not in out
    assert '"msg": "hi"' in out


def test_log_injects_trace_id_within_active_span() -> None:
    sdk_trace = pytest.importorskip("opentelemetry.sdk.trace")
    tracer = sdk_trace.TracerProvider().get_tracer("test")
    with tracer.start_as_current_span("unit"):
        out = _JsonFormatter().format(_record())
    # 32-hex trace id + 16-hex span id, matching wonder-logger's format for cross-service correlation.
    assert '"trace_id"' in out and '"span_id"' in out
