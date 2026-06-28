"""OpenTelemetry bootstrap for the scorer services (the worker + the two model servers).

Mirrors the Node apps' ``src/instrument.ts``: one call at app creation wires OTLP trace + metric export
and auto-instruments FastAPI + asyncpg + httpx. OFF by default — a truthy ``OTEL_SDK_DISABLED`` (the
repo-wide convention, set to ``true`` in compose) makes ``setup_telemetry`` a no-op, so bare deploys stay
dark. When enabled, exporters read the standard ``OTEL_EXPORTER_OTLP_ENDPOINT`` (default the
observability-profile Alloy collector, ``http://alloy:4318``) and the service name comes from
``OTEL_SERVICE_NAME`` (set per container in compose).

Import is lazy and failure-tolerant: if the opentelemetry packages aren't installed, telemetry is simply
skipped rather than crashing the service.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Optional

from .logging import get_logger, log

if TYPE_CHECKING:  # avoid importing fastapi just for the type at runtime
    from fastapi import FastAPI

logger = get_logger("scorer.telemetry")

_configured = False


def telemetry_enabled() -> bool:
    """True unless OTEL_SDK_DISABLED is truthy (matches the Node side + the OTel env convention)."""
    return os.environ.get("OTEL_SDK_DISABLED", "").strip().lower() not in ("1", "true", "yes")


def setup_telemetry(app: "Optional[FastAPI]" = None, *, service_name: Optional[str] = None) -> bool:
    """Configure global trace + metric providers and auto-instrumentation. Idempotent.

    Returns True if telemetry was configured, False if it was skipped (disabled or deps missing).
    """
    global _configured
    # Disabled wins over the idempotency short-circuit: a disabled call must always report False,
    # even if a prior (enabled) call in the same process already configured telemetry. (Otherwise a
    # cross-test _configured=True from an app-startup test makes a later disabled call return True.)
    if not telemetry_enabled():
        return False
    if _configured:
        return True

    try:
        from opentelemetry import metrics, trace
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        log(logger, "error", "opentelemetry packages not installed — telemetry skipped")
        return False

    name = os.environ.get("OTEL_SERVICE_NAME") or service_name or "agora-scorer"
    resource = Resource.create({SERVICE_NAME: name})

    # Exporters read OTEL_EXPORTER_OTLP_ENDPOINT and append the signal path (/v1/traces, /v1/metrics).
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)

    meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())],
    )
    metrics.set_meter_provider(meter_provider)

    AsyncPGInstrumentor().instrument()
    HTTPXClientInstrumentor().instrument()
    if app is not None:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app)

    _configured = True
    log(logger, "info", "telemetry configured", service=name)
    return True
