"""The RoBERTa classifier — loads an HF model warm in RAM and scores text.

STUB: in the foundation pass this returns deterministic placeholder scores and reports
``loaded=False`` so the pipeline can be exercised end-to-end without downloading weights or
pulling in torch at runtime. The implementation pass replaces ``_load`` + ``score`` with a
real ``transformers`` pipeline:

    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    tok = AutoTokenizer.from_pretrained(model)
    mdl = AutoModelForSequenceClassification.from_pretrained(model)  # warm in RAM
    # score(text): tokenize → forward → softmax → {label: prob}

Keep inference CPU-only; threads are pinned by OMP_NUM_THREADS + cpuset (compose).
"""

from __future__ import annotations

import hashlib

from .config import ModelServerConfig


class Classifier:
    def __init__(self, config: ModelServerConfig) -> None:
        self.config = config
        self._loaded = False
        self._load()

    def _load(self) -> None:
        # TODO(scorer): load the HF tokenizer + model warm into RAM here. Stubbed for foundation.
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    def score(self, text: str, context: str | None = None) -> dict[str, float]:
        """Return a label → probability map.

        STUB: deterministic pseudo-scores derived from the text hash so the value is stable
        per input (useful for smoke tests) but clearly not a real model output.
        """
        digest = hashlib.sha256((text or "").encode("utf-8")).digest()
        pseudo = digest[0] / 255.0
        if self.config.kind == "toxicity":
            return {"toxic": round(pseudo, 4), "neutral": round(1.0 - pseudo, 4)}
        # relationship/sentiment
        neg = round(pseudo, 4)
        pos = round(1.0 - pseudo, 4)
        return {"negative": neg, "neutral": round(abs(pos - neg), 4), "positive": pos}

    @staticmethod
    def top(scores: dict[str, float]) -> tuple[str, float]:
        label = max(scores, key=lambda k: scores[k])
        return label, scores[label]
