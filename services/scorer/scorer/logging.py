"""Structured JSON logging.

Emits one JSON object per line (``level``/``time``/``msg`` + arbitrary data fields), roughly
matching the API's wonder-logger JSON output so logs aggregate consistently. Data-object FIRST,
mirroring the Pino convention used across the repo: ``log.error("msg", err=...)``.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from types import ModuleType

# Trace↔log correlation: when OTel is active, stamp each line with the current trace/span id so logs in
# Loki link to their trace in Tempo (matching the Node apps' wonder-logger traceContext plugin). Lazy +
# optional — if opentelemetry isn't installed, logging works unchanged with no trace fields.
# Declared optional so mypy accepts the None fallback (the import binds a module; the except rebinds None).
_otel_trace: ModuleType | None
try:
    from opentelemetry import trace as _otel_trace
except ImportError:  # pragma: no cover - exercised only in deps-missing environments
    _otel_trace = None


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "level": record.levelname.lower(),
            "time": int(time.time() * 1000),
            "msg": record.getMessage(),
        }
        if _otel_trace is not None:
            ctx = _otel_trace.get_current_span().get_span_context()
            if ctx.is_valid:
                # 32-/16-hex lowercase, identical to wonder-logger's output (one Loki regex matches both).
                payload["trace_id"] = format(ctx.trace_id, "032x")
                payload["span_id"] = format(ctx.span_id, "016x")
        data = getattr(record, "data", None)
        if isinstance(data, dict):
            payload.update(data)
        if record.exc_info:
            payload["err"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def get_logger(name: str = "scorer") -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(_JsonFormatter())
        logger.addHandler(handler)
        logger.setLevel(os.environ.get("LOG_LEVEL", "info").upper())
        logger.propagate = False
    return logger


def log(logger: logging.Logger, level: str, msg: str, **data: object) -> None:
    """Convenience: ``log(logger, "info", "consumed job", target_id=...)``."""
    logger.log(getattr(logging, level.upper(), logging.INFO), msg, extra={"data": data})
