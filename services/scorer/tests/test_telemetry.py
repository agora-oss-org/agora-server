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


def test_setup_telemetry_exposes_prometheus_metrics_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Metrics are SCRAPED (:9464) via a real PrometheusMetricReader, never pushed via OTLP.

    Spies on construction rather than inspecting the global MeterProvider afterward — the OTel API only
    honors the *first* ``set_meter_provider`` call per process (later ones warn + no-op), so asserting
    against the live global would be order-dependent across the test session.
    """
    prometheus_client = pytest.importorskip("prometheus_client")
    prometheus_exporter = pytest.importorskip("opentelemetry.exporter.prometheus")
    trace_exporter_mod = pytest.importorskip("opentelemetry.exporter.otlp.proto.http.trace_exporter")
    trace_export_mod = pytest.importorskip("opentelemetry.sdk.trace.export")

    # Stub the trace exporter too — otherwise BatchSpanProcessor's background thread retries a real
    # export against localhost:4318 at interpreter shutdown (noisy + slow), same class of issue this
    # whole change is fixing on the metrics side.
    monkeypatch.setattr(
        trace_exporter_mod.OTLPSpanExporter,
        "export",
        lambda self, spans: trace_export_mod.SpanExportResult.SUCCESS,
    )

    server_calls: list[tuple[int, str]] = []
    monkeypatch.setattr(
        prometheus_client, "start_http_server", lambda port, addr: server_calls.append((port, addr))
    )
    created: list[object] = []
    real_reader_cls = prometheus_exporter.PrometheusMetricReader

    class _SpyReader(real_reader_cls):  # type: ignore[misc, valid-type]
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, **kwargs)
            created.append(self)

    monkeypatch.setattr(prometheus_exporter, "PrometheusMetricReader", _SpyReader)
    monkeypatch.setenv("OTEL_SDK_DISABLED", "false")

    # Reset the module-level idempotency guard so this test is independent of run order.
    import scorer.telemetry as telemetry_module

    monkeypatch.setattr(telemetry_module, "_configured", False)

    assert setup_telemetry(None, service_name="agora-scorer-test") is True
    assert server_calls == [(telemetry_module.METRICS_PORT, "0.0.0.0")]
    assert len(created) == 1

    # Cleanup: this call installs REAL global state (tracer provider + process-wide asyncpg/httpx
    # instrumentation) that outlives monkeypatch's teardown. Shut the span processor down now, while the
    # exporter stub above is still active, so later tests' instrumented calls don't queue spans that hit
    # the real (un-stubbed) exporter at interpreter exit.
    from opentelemetry import trace as otel_trace
    from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.sdk.trace import TracerProvider as SdkTracerProvider

    tracer_provider = otel_trace.get_tracer_provider()
    assert isinstance(tracer_provider, SdkTracerProvider)
    tracer_provider.shutdown()
    AsyncPGInstrumentor().uninstrument()
    HTTPXClientInstrumentor().uninstrument()


def test_log_has_no_trace_id_without_active_span() -> None:
    # No span in context (or OTel absent) → no trace fields, logging works unchanged.
    out = _JsonFormatter().format(_record())
    assert '"trace_id"' not in out
    assert '"msg": "hi"' in out


def test_log_injects_trace_id_within_active_span(monkeypatch: pytest.MonkeyPatch) -> None:
    sdk_trace = pytest.importorskip("opentelemetry.sdk.trace")
    # OTEL_SDK_DISABLED is an OTel-spec env var the SDK's own TracerProvider reads directly (forces a
    # NoOp tracer when true) — not just our app-level gate. conftest defaults it to "true" for hermetic
    # unit tests, so this test (which wants a REAL span) must opt back in for its own scope.
    monkeypatch.setenv("OTEL_SDK_DISABLED", "false")
    tracer = sdk_trace.TracerProvider().get_tracer("test")
    with tracer.start_as_current_span("unit"):
        out = _JsonFormatter().format(_record())
    # 32-hex trace id + 16-hex span id, matching wonder-logger's format for cross-service correlation.
    assert '"trace_id"' in out and '"span_id"' in out
