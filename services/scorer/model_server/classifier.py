"""The RoBERTa classifier — loads an HF text-classification model warm in RAM and scores text.

CPU-only inference (threads pinned by OMP_NUM_THREADS + cpuset in compose). `transformers`/`torch`
are imported **lazily** inside ``_load`` so this module (and the FastAPI app) import cleanly without
torch installed — the heavy deps are only needed when a model is actually loaded (container startup),
which keeps the code unit-testable by injecting a fake ``pipe``.

The model is loaded once and kept resident (warm), so every ``/score`` is a fast in-process forward
pass. ``top_k=None`` makes the HF pipeline return the full label→probability distribution.
"""

from __future__ import annotations

from typing import Callable, Optional

from .config import ModelServerConfig

# Cap input length defensively before the tokenizer's own truncation (a RoBERTa context is ~512
# tokens; characters are a cheap pre-bound so we never hand the tokenizer a megabyte of text).
_MAX_CHARS = 4000

# RoBERTa caps at 512 tokens (514 position embeddings). Many of these models ship a tokenizer with
# model_max_length unset (a huge sentinel), so `truncation=True` alone never truncates and long inputs
# overflow the position embeddings ("index 514 is out of bounds"). We pin model_max_length to this.
_MODEL_MAX_TOKENS = 512

# A "pipe" is any callable text -> list[{"label","score"}] (the HF pipeline, or a fake in tests).
Pipe = Callable[[str], list]


class Classifier:
    def __init__(self, config: ModelServerConfig, pipe: Optional[Pipe] = None) -> None:
        self.config = config
        self._pipe: Optional[Pipe] = pipe
        self._loaded = pipe is not None
        if self._pipe is None:
            self._load()

    def _load(self) -> None:
        # Lazy: torch is only needed here, at startup, inside the model-server container.
        from transformers import AutoTokenizer, pipeline  # type: ignore[import-untyped]

        # Pin model_max_length so truncation=True actually truncates at 512 (see _MODEL_MAX_TOKENS).
        tokenizer = AutoTokenizer.from_pretrained(self.config.model, model_max_length=_MODEL_MAX_TOKENS)
        self._pipe = pipeline(
            "text-classification",
            model=self.config.model,
            tokenizer=tokenizer,
            top_k=None,  # return all labels, not just the argmax
            truncation=True,
            max_length=_MODEL_MAX_TOKENS,
        )
        self._loaded = True

    @property
    def loaded(self) -> bool:
        return self._loaded

    def score(self, text: str, context: str | None = None) -> dict[str, float]:
        """Return a label → probability map for ``text`` (context is accepted but not scored)."""
        if self._pipe is None:
            raise RuntimeError("classifier not loaded")
        out = self._pipe((text or "")[:_MAX_CHARS])
        # top_k=None on a single input yields list[dict]; some versions nest it as [list[dict]].
        if out and isinstance(out[0], list):
            out = out[0]
        return {str(item["label"]).lower(): float(item["score"]) for item in out}

    @staticmethod
    def top(scores: dict[str, float]) -> tuple[str, float]:
        label = max(scores, key=lambda k: scores[k])
        return label, scores[label]
