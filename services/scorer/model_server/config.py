"""Model-server configuration from env.

The same image runs as ``scorer-toxicity`` and ``scorer-relationship`` with different
``SCORER_MODEL`` / ``SCORER_MODEL_KIND`` / ``SCORER_PORT``. CPU threads are pinned via
``OMP_NUM_THREADS`` (compose) + ``cpuset`` so the two model servers run truly in parallel on
disjoint cores.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

_DEFAULT_MODELS = {
    "toxicity": "s-nlp/roberta_toxicity_classifier",
    "relationship": "cardiffnlp/twitter-roberta-base-sentiment-latest",
}


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if (v is not None and v != "") else default


@dataclass(frozen=True)
class ModelServerConfig:
    kind: str = field(default_factory=lambda: _env("SCORER_MODEL_KIND", "toxicity"))
    port: int = field(default_factory=lambda: int(_env("SCORER_PORT", "8001")))

    @property
    def model(self) -> str:
        # Explicit SCORER_MODEL wins; else the per-kind default.
        return _env("SCORER_MODEL", _DEFAULT_MODELS.get(self.kind, _DEFAULT_MODELS["toxicity"]))


def get_config() -> ModelServerConfig:
    return ModelServerConfig()
