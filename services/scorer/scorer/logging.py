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


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "level": record.levelname.lower(),
            "time": int(time.time() * 1000),
            "msg": record.getMessage(),
        }
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
